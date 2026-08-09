"""Guarded HTTP client and JSON inspection helpers for the backend verifier.

Everything here treats the deliverable as hostile input:

* every URL, including each redirect hop, passes the SSRF guard before we connect
* redirects are followed manually so no hop escapes that check
* response bodies stream with a hard byte cap, so a deliverable cannot exhaust
  sandbox memory by advertising a 40 GB response
* responses are cached per run, so ten assertions about one endpoint make one
  request and all ten judge the *same* response rather than ten different ones
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

import httpx

from agent.config import HTTP_TIMEOUT_MS, MAX_REDIRECTS, MAX_RESPONSE_BYTES
from agent.security.url_guard import BlockedURLError, assert_url_allowed

_MISSING = object()


class ResponseTooLargeError(Exception):
    """The deliverable returned more bytes than we are willing to read."""


@dataclass
class HttpExchange:
    """One request/response pair, and the evidence record derived from it."""

    method: str
    url: str
    status: int
    headers: dict[str, str]
    elapsed_ms: int
    body: bytes
    redirect_chain: list[str] = field(default_factory=list)
    truncated: bool = False

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """Parsed JSON body, or `_MISSING`-free ValueError if it is not JSON."""
        return json.loads(self.text)

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def to_evidence(self, max_body_chars: int = 4000) -> dict[str, Any]:
        """Redacted, size-bounded record for the client-facing evidence panel."""
        body_preview = self.text[:max_body_chars]
        return {
            "request": {"method": self.method, "url": self.url},
            "response": {
                "status": self.status,
                "elapsed_ms": self.elapsed_ms,
                "headers": self.headers,
                "body_preview": body_preview,
                "body_truncated": self.truncated or len(self.text) > max_body_chars,
            },
            "redirect_chain": self.redirect_chain,
        }


_REDIRECT_CODES = {301, 302, 303, 307, 308}


class GuardedHttpClient:
    """httpx client with SSRF checks, manual redirects, size caps and caching."""

    def __init__(self, timeout_ms: int = HTTP_TIMEOUT_MS) -> None:
        self._client = httpx.Client(
            follow_redirects=False,
            timeout=timeout_ms / 1000,
            headers={"User-Agent": "GigsFlow-Verifier/1.0"},
        )
        self._cache: dict[str, HttpExchange] = {}

    def __enter__(self) -> GuardedHttpClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def _cache_key(
        method: str, url: str, body: dict[str, Any] | None, headers: dict[str, str]
    ) -> str:
        payload = json.dumps(
            {"m": method, "u": url, "b": body, "h": sorted(headers.items())},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    def request(
        self,
        method: str,
        url: str,
        *,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        use_cache: bool = True,
    ) -> HttpExchange:
        """Perform a guarded request. Raises BlockedURLError / httpx errors."""
        headers = dict(headers or {})
        key = self._cache_key(method, url, body, headers)
        if use_cache and key in self._cache:
            return self._cache[key]

        exchange = self._request_uncached(method, url, body, headers)
        if use_cache:
            self._cache[key] = exchange
        return exchange

    def _request_uncached(
        self,
        method: str,
        url: str,
        body: dict[str, Any] | None,
        headers: dict[str, str],
    ) -> HttpExchange:
        chain: list[str] = []
        current = url
        started = time.monotonic()

        for hop in range(MAX_REDIRECTS + 1):
            assert_url_allowed(current)
            request = self._client.build_request(
                method,
                current,
                json=body if body is not None else None,
                headers=headers,
            )
            response = self._client.send(request, stream=True)
            try:
                if response.status_code in _REDIRECT_CODES and response.headers.get(
                    "location"
                ):
                    if hop == MAX_REDIRECTS:
                        raise BlockedURLError(
                            f"exceeded {MAX_REDIRECTS} redirects starting at {url}"
                        )
                    chain.append(current)
                    current = urljoin(current, response.headers["location"])
                    continue

                collected = bytearray()
                truncated = False
                for chunk in response.iter_bytes():
                    collected.extend(chunk)
                    if len(collected) > MAX_RESPONSE_BYTES:
                        truncated = True
                        break

                elapsed_ms = int((time.monotonic() - started) * 1000)
                return HttpExchange(
                    method=method,
                    url=current,
                    status=response.status_code,
                    headers={k.lower(): v for k, v in response.headers.items()},
                    elapsed_ms=elapsed_ms,
                    body=bytes(collected[:MAX_RESPONSE_BYTES]),
                    redirect_chain=chain,
                    truncated=truncated,
                )
            finally:
                response.close()

        raise BlockedURLError(f"redirect loop starting at {url}")  # pragma: no cover

    def download(self, url: str, max_bytes: int) -> tuple[bytes, str]:
        """Fetch a binary asset (an image deliverable), capped at `max_bytes`.

        Returns (bytes, content_type). Raises ResponseTooLargeError if the
        deliverable exceeds the cap, rather than silently verifying a fragment.
        """
        chain: list[str] = []
        current = url

        for hop in range(MAX_REDIRECTS + 1):
            assert_url_allowed(current)
            request = self._client.build_request("GET", current)
            response = self._client.send(request, stream=True)
            try:
                if response.status_code in _REDIRECT_CODES and response.headers.get(
                    "location"
                ):
                    if hop == MAX_REDIRECTS:
                        raise BlockedURLError(f"exceeded {MAX_REDIRECTS} redirects")
                    chain.append(current)
                    current = urljoin(current, response.headers["location"])
                    continue

                response.raise_for_status()

                # Trust the advertised length only to fail fast; the streaming
                # cap below is what actually enforces the limit.
                advertised = response.headers.get("content-length")
                if advertised and advertised.isdigit() and int(advertised) > max_bytes:
                    raise ResponseTooLargeError(
                        f"content-length {advertised} exceeds cap of {max_bytes} bytes"
                    )

                collected = bytearray()
                for chunk in response.iter_bytes():
                    collected.extend(chunk)
                    if len(collected) > max_bytes:
                        raise ResponseTooLargeError(
                            f"response exceeded cap of {max_bytes} bytes"
                        )

                content_type = response.headers.get("content-type", "").split(";")[0]
                return bytes(collected), content_type.strip().lower()
            finally:
                response.close()

        raise BlockedURLError(f"redirect loop starting at {url}")  # pragma: no cover


# --- JSON field paths --------------------------------------------------------

_PATH_TOKEN = re.compile(r"([^.\[\]]+)|\[(\d+)\]")


def resolve_field_path(data: Any, path: str) -> Any:
    """Resolve a dotted path like `user.roles[0].name`.

    Returns the value, or the module-level `_MISSING` sentinel when any segment
    is absent -- distinguishing "field holds null" from "field is not there",
    which matters because `json_field_equals(expected=None)` is a legal check.
    """
    current = data
    for name, index in _PATH_TOKEN.findall(path):
        if name:
            if not isinstance(current, dict) or name not in current:
                return _MISSING
            current = current[name]
        else:
            position = int(index)
            if not isinstance(current, list) or position >= len(current):
                return _MISSING
            current = current[position]
    return current


def field_exists(data: Any, path: str) -> bool:
    return resolve_field_path(data, path) is not _MISSING


def field_value(data: Any, path: str) -> Any:
    """Value at `path`, or raise KeyError if absent."""
    value = resolve_field_path(data, path)
    if value is _MISSING:
        raise KeyError(path)
    return value
