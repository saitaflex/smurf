"""Playwright tools for the frontend verifier.

One PageSession per verification run: each distinct path is loaded once,
its console errors and screenshot captured, and every assertion against that
path reuses the same loaded state. Page content is only ever inspected with
literal queries (selector present? text present?) — it is never fed to an LLM.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from agent.tools.http_tools import resolve_url

LOAD_TIMEOUT_MS = 30_000
SETTLE_TIMEOUT_MS = 5_000


@dataclass
class PageState:
    url: str
    status: Optional[int] = None
    load_error: str = ""
    console_errors: list[str] = field(default_factory=list)
    screenshot: bytes = b""
    page: object = None  # live playwright Page while the session is open


class PageSession:
    def __init__(self, base_url: str):
        # Imported here so merely importing the module never requires
        # playwright to be installed (the orchestrator catches per-group).
        from playwright.sync_api import sync_playwright

        self.base_url = base_url
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._states: dict[str, PageState] = {}

    def load(self, path: str = "") -> PageState:
        key = path or ""
        if key in self._states:
            return self._states[key]

        url = resolve_url(self.base_url, key)
        state = PageState(url=url)
        page = self._browser.new_page()
        page.on("console",
                lambda msg: state.console_errors.append(msg.text)
                if msg.type == "error" else None)
        page.on("pageerror",
                lambda err: state.console_errors.append(str(err)))
        try:
            resp = page.goto(url, timeout=LOAD_TIMEOUT_MS, wait_until="load")
            state.status = resp.status if resp else None
            try:  # give SPAs a moment to settle; timing out here is fine
                page.wait_for_load_state("networkidle", timeout=SETTLE_TIMEOUT_MS)
            except Exception:
                pass
            state.screenshot = page.screenshot(full_page=True)
            state.page = page
        except Exception as exc:
            state.load_error = f"{exc.__class__.__name__}: {exc}"
            page.close()
        self._states[key] = state
        return state

    def close(self) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()
