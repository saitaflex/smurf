"""Runtime limits for verification. Every bound is env-overridable so the
sandbox can tighten them without a code change."""

from __future__ import annotations

import os


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


# --- network -----------------------------------------------------------------

#: Per-request timeout for backend checks and image downloads.
HTTP_TIMEOUT_MS = _int_env("GIGSFLOW_HTTP_TIMEOUT_MS", 15_000)

#: Redirect hops we follow. Every hop is re-validated against the SSRF guard.
MAX_REDIRECTS = _int_env("GIGSFLOW_MAX_REDIRECTS", 3)

#: Hard cap on any single response body we read into memory.
MAX_RESPONSE_BYTES = _int_env("GIGSFLOW_MAX_RESPONSE_BYTES", 8 * 1024 * 1024)

#: Cap on a downloaded image, checked before decoding (decompression bombs).
MAX_IMAGE_BYTES = _int_env("GIGSFLOW_MAX_IMAGE_BYTES", 12 * 1024 * 1024)

#: Cap on decoded image pixels, guarding Pillow against decompression bombs.
MAX_IMAGE_PIXELS = _int_env("GIGSFLOW_MAX_IMAGE_PIXELS", 50_000_000)


# --- browser -----------------------------------------------------------------

#: Navigation timeout for the single page load a frontend run performs.
PAGE_LOAD_TIMEOUT_MS = _int_env("GIGSFLOW_PAGE_LOAD_TIMEOUT_MS", 20_000)

#: Per-assertion timeout once the page is loaded (selector waits).
SELECTOR_TIMEOUT_MS = _int_env("GIGSFLOW_SELECTOR_TIMEOUT_MS", 5_000)


# --- vision ------------------------------------------------------------------

GROQ_API_URL = os.getenv(
    "GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions"
)
GROQ_VISION_MODEL = os.getenv(
    "GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"
)

#: Below this self-reported confidence a vision answer becomes needs_human_review
#: instead of a pass/fail. We would rather escalate than guess about money.
VISION_CONFIDENCE_FLOOR = float(os.getenv("GIGSFLOW_VISION_CONFIDENCE_FLOOR", "0.7"))

VISION_TIMEOUT_MS = _int_env("GIGSFLOW_VISION_TIMEOUT_MS", 45_000)


# --- test-only escape hatch --------------------------------------------------

def allow_private_hosts() -> bool:
    """Let the SSRF guard through to loopback/private addresses.

    Read at call time, never cached, so a test can set it per-case. This exists
    only so the sub-agent test suite can point at fixtures on 127.0.0.1. It must
    never be set in the sandbox that runs real deliverables: a freelancer-supplied
    URL is untrusted input, and the sandbox holds the Supabase service-role key
    and the agent callback secret in its environment.
    """
    return _bool_env("GIGSFLOW_ALLOW_PRIVATE_HOSTS")
