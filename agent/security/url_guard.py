"""SSRF guard for freelancer-supplied URLs.

`deals.deliverable_url` is attacker-controlled input: the freelancer types it,
and we then fetch it from inside a sandbox whose environment holds the Supabase
service-role key, the agent callback secret and (in some deployments) cloud
instance credentials. A deliverable of `http://169.254.169.254/latest/meta-data/`
would otherwise turn our verifier into a credential-exfiltration proxy.

So every URL a verifier touches -- the deliverable itself, each redirect hop, and
every sub-resource a page requests -- passes through `assert_url_allowed` first.

Residual risk (documented, not fixed): DNS rebinding. We validate the addresses a
hostname resolves to, then hand the URL to httpx/Chromium which resolve it again;
a hostile resolver could answer differently the second time. Closing that needs
connect-to-pinned-IP with a Host header override, which is more surgery than a
hackathon MVP warrants. It is called out in agent/README_VERIFIERS.md.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

from agent.config import allow_private_hosts

ALLOWED_SCHEMES = frozenset({"http", "https"})


class BlockedURLError(Exception):
    """Raised when a URL is refused before any connection is attempted."""


def _ip_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Reject anything that could reach our own infrastructure.

    `is_private` covers RFC1918 and IPv6 unique-local; `is_link_local` covers
    169.254.0.0/16, which is where every major cloud parks its instance metadata
    service. `is_reserved` and `is_unspecified` catch 0.0.0.0 and friends.
    """
    if ip.is_private or ip.is_loopback or ip.is_link_local:
        return False
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return False
    # IPv4-mapped IPv6 (::ffff:127.0.0.1) would otherwise sneak past the checks above.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _ip_is_public(mapped)
    return True


def resolve_host(host: str) -> list[str]:
    """Every address `host` resolves to, A and AAAA alike."""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise BlockedURLError(f"hostname {host!r} does not resolve ({exc.strerror})") from exc
    return sorted({info[4][0] for info in infos})


def assert_url_allowed(url: str) -> list[str]:
    """Validate `url` and return the addresses it resolves to.

    Raises BlockedURLError with a client-readable reason. Callers surface that
    reason as an `error` verdict, never a `fail`: a blocked URL means we could
    not check the deliverable, not that the deliverable is wrong.
    """
    parts = urlsplit(url)

    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise BlockedURLError(
            f"scheme {parts.scheme!r} is not allowed; deliverable URLs must be http or https"
        )

    # Credentials in the URL are never legitimate for a public deliverable and
    # would end up in evidence records.
    if parts.username or parts.password:
        raise BlockedURLError("URL must not embed credentials")

    host = parts.hostname
    if not host:
        raise BlockedURLError("URL has no host")

    if allow_private_hosts():
        return [host]

    addresses = resolve_host(host)
    for raw in addresses:
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError as exc:  # pragma: no cover - getaddrinfo returns valid IPs
            raise BlockedURLError(f"unparseable address {raw!r} for host {host!r}") from exc
        if not _ip_is_public(ip):
            raise BlockedURLError(
                f"host {host!r} resolves to non-public address {raw} -- "
                "deliverables must be reachable on the public internet"
            )
    return addresses


def is_url_allowed(url: str) -> bool:
    """Boolean form, for hot paths like per-request browser interception."""
    try:
        assert_url_allowed(url)
        return True
    except BlockedURLError:
        return False


def join_path(base_url: str, path: str) -> str:
    """Join a checklist-item path onto the deliverable base URL.

    Uses plain concatenation rather than urljoin so an absolute URL in a
    checklist item cannot silently redirect the whole check at a different host
    than the one the freelancer registered as the deliverable.
    """
    if not path:
        return base_url
    if path.startswith(("http://", "https://")):
        raise BlockedURLError(
            "checklist paths must be relative to the deliverable URL, not absolute"
        )
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"
