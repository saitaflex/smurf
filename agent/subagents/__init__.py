"""Verifier registry -- the single entry point the orchestrator imports.

NOTE (unreconciled): the orchestrator on main expects a different interface than
the one below. Preserved verbatim from that side:

    Verifier sub-agent modules live here (owned by track #3).

    Each module must expose:

        def verify_items(items: list[ChecklistItem], ctx: VerificationContext) -> list[ItemResult]

    with one ItemResult per input item, in the same order. See agent/schemas.py
    for the types and agent/orchestrator.py for how modules are dispatched.
    Module names must match the ChecklistItem.sub_agent values:
      frontend_verifier.py, backend_verifier.py, image_verifier.py

Both contracts describe the same job. The differences -- `verify_items` vs `run`,
`ItemResult` vs `VerificationResult`, `item_type`+`params` vs a single
`assertion` dict, and 7 item types vs 15 -- are resolvable with a thin adapter.
The one difference worth settling deliberately: `VerificationContext` carries
`deal_id` and the Supabase service-role key into every sub-agent, while
`DeliverableContext` below withholds both, so a verifier structurally cannot
write to the database or name a deal. That property is the whole "the AI cannot
release funds" argument, and it costs the orchestrator only an upload loop.

Imports are lazy so a backend-only run never pays to load Playwright, and a
machine without Chromium can still run the backend and image verifiers.

    from agent.subagents import get_verifier
    results = get_verifier("backend_verifier")(items, ctx)

Every verifier has the same signature and the same guarantees:

    (list[ChecklistItem], DeliverableContext) -> list[VerificationResult]

* returns one result per item addressed to it, ignoring the rest
* never raises: an unrunnable check becomes an `error` verdict
* never touches the database, Gravv, or anything that moves money
"""

from __future__ import annotations

from typing import Callable

from agent.verification_types import (
    ChecklistItem,
    DeliverableContext,
    VerificationResult,
)

Verifier = Callable[[list[ChecklistItem], DeliverableContext], list[VerificationResult]]

#: Matches the check constraint on checklist_items.sub_agent.
SUB_AGENTS = ("frontend_verifier", "backend_verifier", "image_verifier")

#: Which verifier handles which deals.deliverable_type.
DELIVERABLE_TYPE_TO_SUB_AGENT = {
    "frontend": "frontend_verifier",
    "backend": "backend_verifier",
    "image": "image_verifier",
}


def get_verifier(sub_agent: str) -> Verifier:
    """Resolve a sub_agent name to its run function."""
    if sub_agent == "frontend_verifier":
        from agent.subagents.frontend_verifier import run
    elif sub_agent == "backend_verifier":
        from agent.subagents.backend_verifier import run
    elif sub_agent == "image_verifier":
        from agent.subagents.image_verifier import run
    else:
        raise ValueError(
            f"unknown sub_agent {sub_agent!r}; expected one of {', '.join(SUB_AGENTS)}"
        )
    return run


def run_all(
    items: list[ChecklistItem], ctx: DeliverableContext
) -> list[VerificationResult]:
    """Run every verifier that has work in `items`.

    The orchestrator may prefer to call verifiers individually so it can stream
    each group's results to Supabase as they land; this is the simple path.
    """
    results: list[VerificationResult] = []
    for sub_agent in SUB_AGENTS:
        if any(item.sub_agent == sub_agent for item in items):
            results.extend(get_verifier(sub_agent)(items, ctx))
    return results
