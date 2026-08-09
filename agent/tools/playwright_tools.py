"""Headless-browser session for the frontend verifier.

Two design choices worth stating, because they are what make this safe and fast
enough to run inside a verification sandbox:

**One page load per run.** The session navigates once and every assertion is
evaluated against that single live page. Reloading per assertion would be slower
and, worse, inconsistent -- ten assertions could each see a different render of a
non-deterministic page, producing an evidence set that contradicts itself.

**Every sub-resource is guarded, not just the page URL.** Chromium follows
redirects and fetches images, scripts and XHRs on its own, so validating only the
deliverable URL would leave the door open: a page that loads
`<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/">`
reaches cloud metadata from inside our sandbox. A route interceptor puts the SSRF
guard in front of every single request the browser makes, and aborted requests
are recorded as evidence rather than silently dropped.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

from agent.config import PAGE_LOAD_TIMEOUT_MS, SELECTOR_TIMEOUT_MS
from agent.security.url_guard import assert_url_allowed, is_url_allowed

#: Schemes that never leave the browser process, so the SSRF guard does not apply.
_INERT_SCHEMES = frozenset({"data", "blob", "about", "javascript"})


@dataclass
class ConsoleRecord:
    level: str
    text: str
    source: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"level": self.level, "text": self.text, "source": self.source}


class PageLoadError(Exception):
    """Navigation itself failed -- an `error` verdict, not a `fail`."""


@dataclass
class PageSession:
    """A loaded page plus everything observed while loading it."""

    url: str
    evidence_dir: str

    status: int | None = None
    load_ms: int = 0
    console_errors: list[ConsoleRecord] = field(default_factory=list)
    blocked_requests: list[str] = field(default_factory=list)

    _playwright: Any = None
    _browser: Any = None
    _page: Any = None
    _url_verdicts: dict[str, bool] = field(default_factory=dict)

    def __enter__(self) -> PageSession:
        assert_url_allowed(self.url)
        self._playwright = sync_playwright().start()
        try:
            self._browser = self._playwright.chromium.launch(
                headless=True,
                # The sandbox is already an isolation boundary; Chromium's own
                # sandbox cannot nest inside it without extra privileges.
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            context = self._browser.new_context(
                ignore_https_errors=False,
                viewport={"width": 1280, "height": 900},
            )
            self._page = context.new_page()
            self._install_listeners()
            self._navigate()
        except Exception:
            self.close()
            raise
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        for closer in (self._browser, self._playwright):
            if closer is None:
                continue
            try:
                closer.stop() if hasattr(closer, "stop") else closer.close()
            except Exception:  # pragma: no cover - teardown is best-effort
                pass
        self._browser = None
        self._playwright = None

    # -- setup ----------------------------------------------------------------

    def _allowed(self, url: str) -> bool:
        """SSRF check with a per-session cache; pages request the same host a lot."""
        if urlsplit(url).scheme.lower() in _INERT_SCHEMES:
            return True
        if url not in self._url_verdicts:
            self._url_verdicts[url] = is_url_allowed(url)
        return self._url_verdicts[url]

    def _install_listeners(self) -> None:
        def on_route(route: Any, request: Any) -> None:
            if self._allowed(request.url):
                route.continue_()
            else:
                self.blocked_requests.append(request.url)
                route.abort("blockedbyclient")

        self._page.route("**/*", on_route)
        self._page.on(
            "console",
            lambda msg: (
                self.console_errors.append(
                    ConsoleRecord("error", msg.text, str(msg.location or ""))
                )
                if msg.type == "error"
                else None
            ),
        )
        self._page.on(
            "pageerror",
            lambda exc: self.console_errors.append(
                ConsoleRecord("pageerror", str(exc))
            ),
        )

    def _navigate(self) -> None:
        started = time.monotonic()
        try:
            response = self._page.goto(
                self.url, wait_until="load", timeout=PAGE_LOAD_TIMEOUT_MS
            )
        except PlaywrightError as exc:
            raise PageLoadError(_clean_playwright_message(exc)) from exc
        self.load_ms = int((time.monotonic() - started) * 1000)
        self.status = response.status if response else None

    # -- queries used by assertions -------------------------------------------

    def count(self, selector: str) -> int:
        try:
            return self._page.locator(selector).count()
        except PlaywrightError as exc:
            raise PageLoadError(f"invalid selector {selector!r}: {_clean_playwright_message(exc)}") from exc

    def first_text(self, selector: str) -> str | None:
        locator = self._page.locator(selector).first
        try:
            return locator.inner_text(timeout=SELECTOR_TIMEOUT_MS)
        except PlaywrightError:
            return None

    def body_text(self) -> str:
        try:
            return self._page.inner_text("body", timeout=SELECTOR_TIMEOUT_MS)
        except PlaywrightError:
            # A page with no <body> still has text content worth checking.
            return self._page.content()

    def screenshot(self, name: str) -> str:
        """Full-page PNG saved under the run's evidence directory."""
        os.makedirs(self.evidence_dir, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", name)
        path = os.path.join(self.evidence_dir, f"{safe}.png")
        try:
            self._page.screenshot(path=path, full_page=True)
        except PlaywrightError:
            # Never let evidence capture turn a real verdict into an error.
            self._page.screenshot(path=path)
        return path

    def unexpected_console_errors(self, allow_patterns: list[str]) -> list[ConsoleRecord]:
        compiled = [re.compile(p) for p in allow_patterns]
        return [
            record
            for record in self.console_errors
            if not any(pattern.search(record.text) for pattern in compiled)
        ]


def _clean_playwright_message(exc: Exception) -> str:
    """First line of a Playwright error -- the rest is a stack we do not surface."""
    return str(exc).strip().splitlines()[0]
