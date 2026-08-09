"""Backend verifier against the sample API deliverable."""

from __future__ import annotations

from typing import Any, Callable

from agent.subagents import backend_verifier
from agent.verification_types import Verdict

SUB = "backend_verifier"


def _run(items: list[Any], ctx: Any) -> list[Any]:
    return backend_verifier.run(items, ctx)


def test_http_status_pass_and_fail(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "http_status", "path": "/health", "expected_status": 200}),
        make_item(SUB, {"type": "http_status", "path": "/missing", "expected_status": 200}),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert results[0].verdict is Verdict.PASS
    assert results[1].verdict is Verdict.FAIL
    assert "404" in results[1].detail


def test_json_field_equals_including_nested_paths(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(
            SUB,
            {
                "type": "json_field_equals",
                "path": "/health",
                "field_path": "status",
                "expected": "ok",
            },
        ),
        make_item(
            SUB,
            {
                "type": "json_field_equals",
                "path": "/users",
                "field_path": "users[0].roles[1]",
                "expected": "owner",
            },
        ),
        make_item(
            SUB,
            {
                "type": "json_field_equals",
                "path": "/health",
                "field_path": "status",
                "expected": "degraded",
            },
        ),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert [r.verdict for r in results] == [Verdict.PASS, Verdict.PASS, Verdict.FAIL]


def test_json_shape_reports_every_missing_field(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB,
        {
            "type": "json_shape",
            "path": "/health",
            "required_fields": ["status", "version", "region", "tier"],
        },
    )
    result = _run([item], make_ctx(fixture_server))[0]

    assert result.verdict is Verdict.FAIL
    assert "region" in result.detail and "tier" in result.detail


def test_non_json_body_fails_rather_than_errors(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    """The endpoint answered; it just answered wrongly. That is the freelancer's
    problem (fail), not ours (error)."""
    item = make_item(
        SUB,
        {"type": "json_field_exists", "path": "/not-json", "field_path": "status"},
    )
    result = _run([item], make_ctx(fixture_server))[0]

    assert result.verdict is Verdict.FAIL
    assert "not valid JSON" in result.detail


def test_response_time_under(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "response_time_under", "path": "/health", "max_ms": 5000}),
        make_item(SUB, {"type": "response_time_under", "path": "/slow", "max_ms": 100}),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert results[0].verdict is Verdict.PASS
    assert results[1].verdict is Verdict.FAIL


def test_header_present_with_and_without_expected_value(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "header_present", "path": "/health", "header": "X-Powered-By"}),
        make_item(
            SUB,
            {
                "type": "header_present",
                "path": "/health",
                "header": "X-Powered-By",
                "expected_value": "something-else",
            },
        ),
        make_item(SUB, {"type": "header_present", "path": "/health", "header": "X-Absent"}),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert [r.verdict for r in results] == [Verdict.PASS, Verdict.FAIL, Verdict.FAIL]


def test_post_with_body(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB,
        {
            "type": "json_field_equals",
            "path": "/echo",
            "method": "POST",
            "request_body": {"name": "Ada"},
            "field_path": "received.name",
            "expected": "Ada",
        },
    )
    assert _run([item], make_ctx(fixture_server))[0].verdict is Verdict.PASS


def test_redirects_are_followed_and_revalidated(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(
        SUB, {"type": "json_field_equals", "path": "/redirect", "field_path": "status", "expected": "ok"}
    )
    result = _run([item], make_ctx(fixture_server))[0]
    assert result.verdict is Verdict.PASS


def test_malformed_item_errors_without_sinking_the_run(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "http_status", "path": "/health", "expected_status": 200}),
        make_item(SUB, {"type": "nonsense_check", "path": "/health"}),
        make_item(SUB, {"type": "http_status", "path": "/missing", "expected_status": 404}),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert [r.verdict for r in results] == [Verdict.PASS, Verdict.ERROR, Verdict.PASS]
    assert "not a valid backend_verifier assertion" in results[1].detail


def test_unreachable_deliverable_errors_every_item(
    make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item(SUB, {"type": "http_status", "path": "/health", "expected_status": 200}),
        make_item(SUB, {"type": "http_status", "path": "/users", "expected_status": 200}),
    ]
    # Port 1 on loopback: nothing listens there.
    results = _run(items, make_ctx("http://127.0.0.1:1"))

    assert all(r.verdict is Verdict.ERROR for r in results)


def test_evidence_records_the_exchange(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    item = make_item(SUB, {"type": "http_status", "path": "/health", "expected_status": 200})
    result = _run([item], make_ctx(fixture_server))[0]

    evidence = result.evidence[0].inline
    assert evidence["response"]["status"] == 200
    assert "ok" in evidence["response"]["body_preview"]


def test_items_for_other_sub_agents_are_ignored(
    fixture_server: str, make_ctx: Callable, make_item: Callable
) -> None:
    items = [
        make_item("frontend_verifier", {"type": "element_exists", "selector": "h1"}),
        make_item(SUB, {"type": "http_status", "path": "/health", "expected_status": 200}),
    ]
    results = _run(items, make_ctx(fixture_server))

    assert len(results) == 1
