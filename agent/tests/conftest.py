"""Shared fixtures. The suite runs entirely against local fixtures -- no network,
no Supabase, no Gravv, no model calls -- so task 3 is provable in isolation."""

from __future__ import annotations

import os
from typing import Any, Callable

import pytest

from agent.samples.fixture_server import start_fixture_server
from agent.verification_types import ChecklistItem, DeliverableContext


@pytest.fixture(autouse=True)
def allow_local_fixtures(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let the SSRF guard reach 127.0.0.1, where the fixture server lives.

    Autouse so every test gets it; `test_url_guard.py` switches it back off to
    prove the guard actually blocks what it claims to.
    """
    monkeypatch.setenv("GIGSFLOW_ALLOW_PRIVATE_HOSTS", "1")


@pytest.fixture(scope="session")
def fixture_server() -> Any:
    base_url, shutdown = start_fixture_server()
    try:
        yield base_url
    finally:
        shutdown()


@pytest.fixture
def evidence_dir(tmp_path: Any) -> str:
    path = tmp_path / "evidence"
    path.mkdir()
    return str(path)


@pytest.fixture
def make_ctx(evidence_dir: str) -> Callable[[str], DeliverableContext]:
    def factory(deliverable_url: str) -> DeliverableContext:
        return DeliverableContext(
            deliverable_url=deliverable_url, evidence_dir=evidence_dir, run_id="test-run"
        )

    return factory


@pytest.fixture
def make_item() -> Callable[..., ChecklistItem]:
    counter = {"n": 0}

    def factory(
        sub_agent: str, assertion: dict[str, Any], label: str = "check"
    ) -> ChecklistItem:
        counter["n"] += 1
        return ChecklistItem(
            id=f"item-{counter['n']}",
            requirement_id=f"REQ-{counter['n']:03d}",
            label=label,
            sub_agent=sub_agent,
            assertion=assertion,
            sort_order=counter["n"],
        )

    return factory


def has_chromium() -> bool:
    """Whether a Playwright browser is installed in this environment."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:  # pragma: no cover
        return False
    try:
        with sync_playwright() as p:
            return bool(p.chromium.executable_path and os.path.exists(p.chromium.executable_path))
    except Exception:  # pragma: no cover
        return False


needs_chromium = pytest.mark.skipif(
    not has_chromium(), reason="Playwright Chromium is not installed"
)
