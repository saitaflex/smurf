"""Frontend verifier against the sample page deliverables."""

from __future__ import annotations

import os
from typing import Callable

from agent.subagents import frontend_verifier
from agent.tests.conftest import needs_chromium
from agent.verification_types import Verdict

SUB = "frontend_verifier"

pytestmark = needs_chromium


def test_good_page_satisfies_every_assertion(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "page_loads"}),
        make_item(SUB, {"type": "element_exists", "selector": "form#login"}),
        make_item(SUB, {"type": "element_exists", "selector": "ul.feature li", "min_count": 3}),
        make_item(SUB, {"type": "text_present", "text": "Live tracking"}),
        make_item(
            SUB,
            {
                "type": "element_text_matches",
                "selector": "#title",
                "expected_text": "Acme Dashboard",
                "match": "exact",
            },
        ),
        make_item(SUB, {"type": "no_console_errors"}),
    ]
    results = frontend_verifier.run(items, make_ctx(f"{fixture_server}/pages/good.html"))

    assert [r.verdict for r in results] == [Verdict.PASS] * 6


def test_broken_page_fails_the_right_assertions(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "page_loads"}),
        make_item(SUB, {"type": "element_exists", "selector": "form#login"}),
        make_item(
            SUB,
            {
                "type": "element_text_matches",
                "selector": "#title",
                "expected_text": "Acme Dashboard",
                "match": "exact",
            },
        ),
        make_item(SUB, {"type": "no_console_errors"}),
    ]
    results = frontend_verifier.run(items, make_ctx(f"{fixture_server}/pages/broken.html"))

    # The page itself loads fine -- it is the agreed content that is missing.
    assert results[0].verdict is Verdict.PASS
    assert results[1].verdict is Verdict.FAIL
    assert "matched 0 element" in results[1].detail
    assert results[2].verdict is Verdict.FAIL
    assert "Dasboard" in results[2].detail  # the actual text, quoted back as evidence
    assert results[3].verdict is Verdict.FAIL


def test_allow_patterns_suppress_expected_console_noise(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB,
        {"type": "no_console_errors", "allow_patterns": ["renderShipmentTable|__shipments|not defined"]},
    )
    result = frontend_verifier.run(
        [item], make_ctx(f"{fixture_server}/pages/broken.html")
    )[0]

    assert result.verdict is Verdict.PASS


def test_screenshot_evidence_is_captured(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(SUB, {"type": "page_loads"})
    result = frontend_verifier.run([item], make_ctx(f"{fixture_server}/pages/good.html"))[0]

    path = result.primary_evidence_path
    assert path and os.path.exists(path) and os.path.getsize(path) > 0


def test_console_evidence_lists_the_errors(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(SUB, {"type": "no_console_errors"})
    result = frontend_verifier.run([item], make_ctx(f"{fixture_server}/pages/broken.html"))[0]

    console = [e for e in result.evidence if e.kind == "console_log"][0]
    assert console.inline["errors"], "the uncaught page error should be recorded"


def test_unreachable_page_errors_every_item(
    make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "page_loads"}),
        make_item(SUB, {"type": "element_exists", "selector": "h1"}),
    ]
    results = frontend_verifier.run(items, make_ctx("http://127.0.0.1:1/"))

    assert all(r.verdict is Verdict.ERROR for r in results)


def test_malformed_regex_is_an_error_not_a_fail(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    """A broken checklist item is our bug, not the freelancer's failure."""
    item = make_item(
        SUB,
        {
            "type": "element_text_matches",
            "selector": "#title",
            "expected_text": "Acme (Dashboard",
            "match": "regex",
        },
    )
    result = frontend_verifier.run([item], make_ctx(f"{fixture_server}/pages/good.html"))[0]

    assert result.verdict is Verdict.ERROR
    assert "invalid regex" in result.detail
