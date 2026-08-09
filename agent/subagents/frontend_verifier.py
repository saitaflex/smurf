"""Frontend verifier -- checks a deployed page against locked assertions.

Deliverable shape: a URL serving an HTML page.

The whole run is one browser launch and one navigation. Assertions are evaluated
against that single live page, so the screenshot the client sees is the exact
render the verdicts were computed from.

No language model is involved. Every assertion here reduces to a DOM query, a
string comparison or a console-message count -- deterministic operations whose
answer is the same on every run. That is a deliberate choice: a model asked "does
this page have a working login form?" produces a defensible-sounding answer that
cannot be audited, while `element_exists(selector="form#login")` produces a fact
the freelancer can dispute with evidence.
"""

from __future__ import annotations

import re

from agent.assertions import (
    ElementExists,
    ElementTextMatches,
    NoConsoleErrors,
    PageLoads,
    TextPresent,
)
from agent.subagents.base import all_error, describe_exception, items_for, run_items
from agent.tools.playwright_tools import PageLoadError, PageSession
from agent.verification_types import (
    ChecklistItem,
    DeliverableContext,
    Evidence,
    VerificationResult,
    Verdict,
)

SUB_AGENT = "frontend_verifier"


def run(
    items: list[ChecklistItem], ctx: DeliverableContext
) -> list[VerificationResult]:
    """Verify every frontend checklist item against `ctx.deliverable_url`."""
    mine = items_for(items, SUB_AGENT)
    if not mine:
        return []

    try:
        with PageSession(url=ctx.deliverable_url, evidence_dir=ctx.evidence_dir) as page:
            # Captured once, before any assertion runs, and attached to every
            # result: the client should see the page as it was judged.
            shot = Evidence(
                kind="screenshot",
                media_type="image/png",
                local_path=page.screenshot("page"),
            )
            return run_items(
                mine, SUB_AGENT, _dispatcher(page, shot)
            )
    except PageLoadError as exc:
        return all_error(mine, f"the page could not be loaded -- {exc}")
    except Exception as exc:  # noqa: BLE001 - session setup failure is one fact
        return all_error(mine, describe_exception(exc))


def _dispatcher(page: PageSession, shot: Evidence):
    def dispatch(item: ChecklistItem, assertion):
        evidence = [shot]

        if isinstance(assertion, PageLoads):
            return _page_loads(page, assertion, evidence)
        if isinstance(assertion, ElementExists):
            return _element_exists(page, assertion, evidence)
        if isinstance(assertion, TextPresent):
            return _text_present(page, assertion, evidence)
        if isinstance(assertion, ElementTextMatches):
            return _element_text_matches(page, assertion, evidence)
        if isinstance(assertion, NoConsoleErrors):
            return _no_console_errors(page, assertion, evidence)

        # Unreachable while assertions.py and this dispatcher agree; kept so a
        # newly added assertion type fails loudly instead of silently passing.
        raise NotImplementedError(
            f"{SUB_AGENT} has no handler for {type(assertion).__name__}"
        )

    return dispatch


def _page_loads(page: PageSession, assertion: PageLoads, evidence: list[Evidence]):
    if page.status != assertion.expected_status:
        return (
            Verdict.FAIL,
            f"expected HTTP {assertion.expected_status}, page returned {page.status}",
            evidence,
        )
    if page.load_ms > assertion.max_load_ms:
        return (
            Verdict.FAIL,
            f"page took {page.load_ms} ms to load, limit was {assertion.max_load_ms} ms",
            evidence,
        )
    return (
        Verdict.PASS,
        f"page returned HTTP {page.status} and finished loading in {page.load_ms} ms",
        evidence,
    )


def _element_exists(page: PageSession, assertion: ElementExists, evidence: list[Evidence]):
    found = page.count(assertion.selector)
    if found >= assertion.min_count:
        return (
            Verdict.PASS,
            f"selector {assertion.selector!r} matched {found} element(s), "
            f"needed at least {assertion.min_count}",
            evidence,
        )
    return (
        Verdict.FAIL,
        f"selector {assertion.selector!r} matched {found} element(s), "
        f"needed at least {assertion.min_count}",
        evidence,
    )


def _text_present(page: PageSession, assertion: TextPresent, evidence: list[Evidence]):
    body = page.body_text()
    haystack = body if assertion.case_sensitive else body.lower()
    needle = assertion.text if assertion.case_sensitive else assertion.text.lower()
    if needle in haystack:
        return Verdict.PASS, f"found the text {assertion.text!r} on the page", evidence
    return (
        Verdict.FAIL,
        f"the text {assertion.text!r} does not appear anywhere on the rendered page",
        evidence,
    )


def _element_text_matches(
    page: PageSession, assertion: ElementTextMatches, evidence: list[Evidence]
):
    actual = page.first_text(assertion.selector)
    if actual is None:
        return (
            Verdict.FAIL,
            f"no element matched selector {assertion.selector!r}, so its text could not be compared",
            evidence,
        )

    left = actual if assertion.case_sensitive else actual.lower()
    right = (
        assertion.expected_text
        if assertion.case_sensitive
        else assertion.expected_text.lower()
    )

    if assertion.match == "exact":
        ok = left.strip() == right.strip()
    elif assertion.match == "contains":
        ok = right in left
    else:
        flags = 0 if assertion.case_sensitive else re.IGNORECASE
        try:
            ok = re.search(assertion.expected_text, actual, flags) is not None
        except re.error as exc:
            # A malformed pattern is a broken checklist item, not a bad deliverable.
            return Verdict.ERROR, f"invalid regex in checklist item: {exc}", evidence

    verdict = Verdict.PASS if ok else Verdict.FAIL
    return (
        verdict,
        f"element {assertion.selector!r} has text {actual.strip()[:200]!r}; "
        f"expected it to {assertion.match} {assertion.expected_text!r}",
        evidence,
    )


def _no_console_errors(
    page: PageSession, assertion: NoConsoleErrors, evidence: list[Evidence]
):
    unexpected = page.unexpected_console_errors(assertion.allow_patterns)
    log = Evidence(
        kind="console_log",
        media_type="application/json",
        inline={
            "errors": [record.to_dict() for record in page.console_errors],
            "blocked_requests": page.blocked_requests,
            "allow_patterns": assertion.allow_patterns,
        },
    )
    evidence = [*evidence, log]

    if unexpected:
        first = unexpected[0].text[:200]
        return (
            Verdict.FAIL,
            f"{len(unexpected)} console error(s) during load; first was: {first}",
            evidence,
        )
    return Verdict.PASS, "no console errors during page load", evidence
