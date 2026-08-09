"""Backend verifier -- checks a deployed HTTP API against locked assertions.

Deliverable shape: a base URL. Every assertion names a `path` relative to it, so
a checklist item cannot redirect the run at a host the freelancer never
registered as the deliverable.

Responses are cached per (method, path, body) for the duration of a run: ten
assertions about `/health` make one request, and all ten judge the same response
rather than ten different ones. `response_time_under` deliberately opts out of
that cache -- timing a cached response would measure a dictionary lookup.

Like the frontend verifier, no model is involved. Status codes, JSON field paths
and header values are facts.
"""

from __future__ import annotations

import json

from agent.assertions import (
    HeaderPresent,
    HttpStatus,
    JsonFieldEquals,
    JsonFieldExists,
    JsonShape,
    ResponseTimeUnder,
)
from agent.subagents.base import all_error, describe_exception, items_for, run_items
from agent.tools.http_tools import (
    GuardedHttpClient,
    HttpExchange,
    field_exists,
    field_value,
)
from agent.security.url_guard import assert_url_allowed, join_path
from agent.verification_types import (
    ChecklistItem,
    DeliverableContext,
    Evidence,
    VerificationResult,
    Verdict,
)

SUB_AGENT = "backend_verifier"


def run(
    items: list[ChecklistItem], ctx: DeliverableContext
) -> list[VerificationResult]:
    """Verify every backend checklist item against `ctx.deliverable_url`."""
    mine = items_for(items, SUB_AGENT)
    if not mine:
        return []

    try:
        assert_url_allowed(ctx.deliverable_url)
    except Exception as exc:  # noqa: BLE001 - a refused base URL sinks every item
        return all_error(mine, describe_exception(exc))

    with GuardedHttpClient() as client:
        return run_items(mine, SUB_AGENT, _dispatcher(client, ctx.deliverable_url))


def _dispatcher(client: GuardedHttpClient, base_url: str):
    def dispatch(item: ChecklistItem, assertion):
        url = join_path(base_url, assertion.path)
        # Timing assertions must measure a real round trip, not a cache hit.
        fresh = isinstance(assertion, ResponseTimeUnder)
        exchange = client.request(
            assertion.method,
            url,
            body=assertion.request_body,
            headers=assertion.headers,
            use_cache=not fresh,
        )
        evidence = [
            Evidence(
                kind="http_exchange",
                media_type="application/json",
                inline=exchange.to_evidence(),
            )
        ]

        if isinstance(assertion, HttpStatus):
            return _http_status(exchange, assertion, evidence)
        if isinstance(assertion, JsonFieldEquals):
            return _json_field_equals(exchange, assertion, evidence)
        if isinstance(assertion, JsonFieldExists):
            return _json_field_exists(exchange, assertion, evidence)
        if isinstance(assertion, JsonShape):
            return _json_shape(exchange, assertion, evidence)
        if isinstance(assertion, ResponseTimeUnder):
            return _response_time_under(exchange, assertion, evidence)
        if isinstance(assertion, HeaderPresent):
            return _header_present(exchange, assertion, evidence)

        raise NotImplementedError(
            f"{SUB_AGENT} has no handler for {type(assertion).__name__}"
        )

    return dispatch


def _decode_json(exchange: HttpExchange):
    """Parsed body, or a FAIL verdict tuple if the endpoint did not return JSON."""
    try:
        return exchange.json(), None
    except json.JSONDecodeError:
        preview = exchange.text.strip()[:120]
        return None, (
            f"{exchange.method} {exchange.url} returned HTTP {exchange.status} "
            f"with a body that is not valid JSON: {preview!r}"
        )


def _http_status(exchange: HttpExchange, assertion: HttpStatus, evidence):
    if exchange.status == assertion.expected_status:
        return (
            Verdict.PASS,
            f"{exchange.method} {exchange.url} returned HTTP {exchange.status} as required",
            evidence,
        )
    return (
        Verdict.FAIL,
        f"{exchange.method} {exchange.url} returned HTTP {exchange.status}, "
        f"expected {assertion.expected_status}",
        evidence,
    )


def _json_field_equals(exchange: HttpExchange, assertion: JsonFieldEquals, evidence):
    payload, problem = _decode_json(exchange)
    if problem:
        return Verdict.FAIL, problem, evidence

    try:
        actual = field_value(payload, assertion.field_path)
    except KeyError:
        return (
            Verdict.FAIL,
            f"the response has no field {assertion.field_path!r}",
            evidence,
        )

    if actual == assertion.expected:
        return (
            Verdict.PASS,
            f"{assertion.field_path} == {json.dumps(assertion.expected, default=str)}",
            evidence,
        )
    return (
        Verdict.FAIL,
        f"{assertion.field_path} is {json.dumps(actual, default=str)[:200]}, "
        f"expected {json.dumps(assertion.expected, default=str)[:200]}",
        evidence,
    )


def _json_field_exists(exchange: HttpExchange, assertion: JsonFieldExists, evidence):
    payload, problem = _decode_json(exchange)
    if problem:
        return Verdict.FAIL, problem, evidence

    if field_exists(payload, assertion.field_path):
        return Verdict.PASS, f"the response contains {assertion.field_path!r}", evidence
    return Verdict.FAIL, f"the response has no field {assertion.field_path!r}", evidence


def _json_shape(exchange: HttpExchange, assertion: JsonShape, evidence):
    payload, problem = _decode_json(exchange)
    if problem:
        return Verdict.FAIL, problem, evidence

    missing = [f for f in assertion.required_fields if not field_exists(payload, f)]
    if missing:
        return (
            Verdict.FAIL,
            f"the response is missing required field(s): {', '.join(missing)}",
            evidence,
        )
    return (
        Verdict.PASS,
        f"the response contains all {len(assertion.required_fields)} required field(s)",
        evidence,
    )


def _response_time_under(exchange: HttpExchange, assertion: ResponseTimeUnder, evidence):
    if exchange.elapsed_ms <= assertion.max_ms:
        return (
            Verdict.PASS,
            f"{exchange.url} responded in {exchange.elapsed_ms} ms, "
            f"under the {assertion.max_ms} ms limit",
            evidence,
        )
    return (
        Verdict.FAIL,
        f"{exchange.url} responded in {exchange.elapsed_ms} ms, "
        f"over the {assertion.max_ms} ms limit",
        evidence,
    )


def _header_present(exchange: HttpExchange, assertion: HeaderPresent, evidence):
    actual = exchange.header(assertion.header)
    if actual is None:
        return (
            Verdict.FAIL,
            f"the response has no {assertion.header!r} header",
            evidence,
        )
    if assertion.expected_value is None:
        return (
            Verdict.PASS,
            f"the response carries {assertion.header}: {actual[:120]}",
            evidence,
        )
    if actual.strip().lower() == assertion.expected_value.strip().lower():
        return (
            Verdict.PASS,
            f"{assertion.header} == {actual[:120]!r} as required",
            evidence,
        )
    return (
        Verdict.FAIL,
        f"{assertion.header} is {actual[:120]!r}, expected {assertion.expected_value!r}",
        evidence,
    )
