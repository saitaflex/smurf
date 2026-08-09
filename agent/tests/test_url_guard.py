"""The SSRF guard is the security boundary between a freelancer-supplied URL and
a sandbox holding the service-role key. These tests turn the local-fixture escape
hatch back off and prove the guard blocks what it promises to."""

from __future__ import annotations

import pytest

from agent.security.url_guard import (
    BlockedURLError,
    assert_url_allowed,
    is_url_allowed,
    join_path,
)


@pytest.fixture(autouse=True)
def enforce_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    """Override the suite-wide escape hatch: here the guard runs for real."""
    monkeypatch.setenv("GIGSFLOW_ALLOW_PRIVATE_HOSTS", "0")


@pytest.mark.parametrize(
    "url,reason",
    [
        ("http://127.0.0.1/admin", "loopback"),
        ("http://localhost:3000/", "loopback by name"),
        ("http://10.0.0.5/internal", "RFC1918"),
        ("http://192.168.1.1/", "RFC1918"),
        ("http://169.254.169.254/latest/meta-data/", "cloud instance metadata"),
        ("http://[::1]/", "IPv6 loopback"),
        ("http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback"),
        ("http://0.0.0.0/", "unspecified"),
    ],
)
def test_blocks_internal_addresses(url: str, reason: str) -> None:
    with pytest.raises(BlockedURLError):
        assert_url_allowed(url)
    assert is_url_allowed(url) is False, reason


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "javascript:alert(1)",
    ],
)
def test_blocks_non_http_schemes(url: str) -> None:
    with pytest.raises(BlockedURLError, match="scheme"):
        assert_url_allowed(url)


def test_blocks_embedded_credentials() -> None:
    with pytest.raises(BlockedURLError, match="credentials"):
        assert_url_allowed("http://user:secret@8.8.8.8/")


def test_allows_public_address() -> None:
    # A literal public IP, so the test needs no DNS and no outbound traffic.
    assert assert_url_allowed("http://8.8.8.8/health") == ["8.8.8.8"]


def test_unresolvable_host_is_blocked() -> None:
    with pytest.raises(BlockedURLError, match="does not resolve"):
        assert_url_allowed("http://this-host-does-not-exist.invalid/")


def test_join_path_refuses_absolute_urls() -> None:
    """A checklist item must not be able to point the run at another host."""
    with pytest.raises(BlockedURLError, match="relative"):
        join_path("https://deliverable.example.com", "http://169.254.169.254/")


def test_join_path_normalises_slashes() -> None:
    assert join_path("https://x.example/", "/health") == "https://x.example/health"
    assert join_path("https://x.example", "health") == "https://x.example/health"
