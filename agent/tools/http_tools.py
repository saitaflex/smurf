"""HTTP tools for the backend verifier — literal request/response checks.

Response bodies are data to compare against locked assertions, never
instructions: nothing here feeds content into a prompt.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urljoin

import httpx

ALLOWED_METHODS = {"GET", "HEAD", "POST", "OPTIONS"}
BODY_SNIPPET_LIMIT = 2000


def resolve_url(base_url: str, path: str) -> str:
    """Resolve an assertion's path against the deliverable URL.

    Absolute http(s) paths are allowed as-is (the planner may emit full URLs);
    anything else is joined onto the deliverable base.
    """
    if path.startswith(("http://", "https://")):
        return path
    base = base_url if base_url.endswith("/") else base_url + "/"
    return urljoin(base, path.lstrip("/"))


def fetch(url: str, method: str = "GET", timeout: float = 20.0) -> httpx.Response:
    method = method.upper()
    if method not in ALLOWED_METHODS:
        raise ValueError(f"method {method!r} not allowed")
    with httpx.Client(follow_redirects=True, timeout=timeout) as client:
        return client.request(method, url)


def response_summary(resp: httpx.Response) -> dict[str, Any]:
    """Compact evidence record of a request/response pair."""
    return {
        "request": {"method": resp.request.method, "url": str(resp.request.url)},
        "status_code": resp.status_code,
        "content_type": resp.headers.get("content-type", ""),
        "elapsed_ms": int(resp.elapsed.total_seconds() * 1000),
        "body_snippet": resp.text[:BODY_SNIPPET_LIMIT],
    }


def json_path_get(data: Any, dotted_path: str) -> tuple[bool, Any]:
    """Traverse dot notation like "data.items.0.name". Returns (found, value)."""
    current = data
    for part in dotted_path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return False, None
            current = current[part]
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return False, None
        else:
            return False, None
    return True, current


def values_equal(actual: Any, expected: Any) -> bool:
    """Literal comparison with one forgiveness: numbers and their string forms
    compare equal ("42" == 42), since JSON sources are inconsistent there."""
    if actual == expected:
        return True
    try:
        return float(actual) == float(expected)
    except (TypeError, ValueError):
        return False
