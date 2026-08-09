"""Shared execution shell for the three verifier sub-agents.

Every verifier is a pure function of (locked checklist, deliverable URL) to a
list of typed results. None of them reads or writes the database, calls Gravv, or
knows the deal amount -- that separation is what makes "the AI cannot release
funds" a structural fact rather than a policy we hope holds.

This module owns the invariants that must hold for all three:

* one bad checklist item can never abort the run -- each is parsed, executed and
  timed independently, and a raised exception becomes an `error` verdict for that
  item alone
* a check that could not be *performed* yields `error`, never `fail`. `fail` is
  reserved for "we ran the check and the deliverable did not satisfy it", because
  the client sees fails as the freelancer's problem
"""

from __future__ import annotations

import time
from typing import Any, Callable, Iterable

import httpx

from agent.assertions import AssertionParseError, parse_assertion
from agent.security.url_guard import BlockedURLError
from agent.verification_types import (
    ChecklistItem,
    Evidence,
    VerificationResult,
    Verdict,
)

#: A handler takes the item and its parsed assertion, and returns a verdict.
Dispatch = Callable[[ChecklistItem, Any], tuple[Verdict, str, list[Evidence]]]


def describe_exception(exc: BaseException) -> str:
    """A client-readable reason. Never leaks a stack trace into evidence."""
    if isinstance(exc, BlockedURLError):
        return f"URL refused by safety guard: {exc}"
    if isinstance(exc, httpx.TimeoutException):
        return "the deliverable did not respond before the timeout"
    if isinstance(exc, httpx.ConnectError):
        return f"could not connect to the deliverable: {exc}"
    if isinstance(exc, httpx.HTTPError):
        return f"HTTP error contacting the deliverable: {exc}"
    message = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def items_for(items: Iterable[ChecklistItem], sub_agent: str) -> list[ChecklistItem]:
    """The subset addressed to this verifier, in the planner's declared order."""
    return sorted(
        (item for item in items if item.sub_agent == sub_agent),
        key=lambda item: (item.sort_order, item.id),
    )


def all_error(
    items: Iterable[ChecklistItem], detail: str, evidence: list[Evidence] | None = None
) -> list[VerificationResult]:
    """Mark every item as `error` -- used when the session itself cannot start.

    If the deliverable URL is unreachable, that is one fact about the run, not N
    independent failures, so every item carries the same reason.
    """
    return [
        VerificationResult(
            checklist_item_id=item.id,
            verdict=Verdict.ERROR,
            detail=detail,
            evidence=list(evidence or []),
        )
        for item in items
    ]


def run_items(
    items: Iterable[ChecklistItem], sub_agent: str, dispatch: Dispatch
) -> list[VerificationResult]:
    """Parse, execute and time each item, isolating failures to that item."""
    results: list[VerificationResult] = []

    for item in items:
        started = time.monotonic()

        try:
            assertion = parse_assertion(sub_agent, item.assertion)
        except AssertionParseError as exc:
            results.append(
                _result(
                    item,
                    Verdict.ERROR,
                    f"checklist item is not a valid {sub_agent} assertion -- {exc}",
                    [],
                    started,
                )
            )
            continue

        try:
            verdict, detail, evidence = dispatch(item, assertion)
        except Exception as exc:  # noqa: BLE001 - one item must not sink the run
            results.append(
                _result(item, Verdict.ERROR, describe_exception(exc), [], started)
            )
            continue

        results.append(_result(item, verdict, detail, evidence, started))

    return results


def _result(
    item: ChecklistItem,
    verdict: Verdict,
    detail: str,
    evidence: list[Evidence],
    started: float,
) -> VerificationResult:
    return VerificationResult(
        checklist_item_id=item.id,
        verdict=verdict,
        detail=detail,
        evidence=evidence,
        duration_ms=int((time.monotonic() - started) * 1000),
    )
