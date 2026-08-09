"""Verification orchestrator — entrypoint of the sandbox run.

Runs inside the Vercel Sandbox. Reads the locked checklist for a deal from
Supabase (via the deal's active contract), dispatches item groups to the
matching verifier sub-agent, streams each result into verification_results as
it completes (the UI shows live progress via Supabase Realtime on that
table), aggregates an overall verdict, and reports completion.

Completion reporting is belt-and-braces:
1. The verification_runs row is always updated directly in Supabase.
2. The Next.js callback (VERIFY_CALLBACK_URL) is POSTed if configured — it
   performs the deal state transition.
3. If the callback is unreachable (e.g. local dev without a public URL), the
   orchestrator falls back to transitioning the deal row itself, so a demo on
   localhost never gets stuck in 'verifying'.

This module never touches payments — its job ends at posting the verdict.

Required env: RUN_ID, DEAL_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
AGENT_CALLBACK_SECRET. Optional: VERIFY_CALLBACK_URL, GROQ_API_KEY (image
verifier).
"""
from __future__ import annotations

import importlib
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

import httpx

from agent.schemas import (
    ChecklistItem,
    ItemResult,
    OverallVerdict,
    Verdict,
    VerificationContext,
    aggregate_verdict,
)

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
RUN_ID = os.environ["RUN_ID"]
DEAL_ID = os.environ["DEAL_ID"]
CALLBACK_URL = os.environ.get("VERIFY_CALLBACK_URL", "")
CALLBACK_SECRET = os.environ.get("AGENT_CALLBACK_SECRET", "")

REST = f"{SUPABASE_URL}/rest/v1"
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get(path: str, params: dict) -> list[dict]:
    resp = httpx.get(f"{REST}/{path}", params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _post(path: str, body: dict) -> None:
    resp = httpx.post(f"{REST}/{path}", json=body, headers=HEADERS, timeout=30)
    resp.raise_for_status()


def _patch(path: str, params: dict, body: dict) -> list[dict]:
    resp = httpx.patch(f"{REST}/{path}", params=params, json=body,
                       headers={**HEADERS, "Prefer": "return=representation"},
                       timeout=30)
    resp.raise_for_status()
    return resp.json()


def load_inputs() -> tuple[dict, dict, list[ChecklistItem]]:
    deals = _get("deals", {"id": f"eq.{DEAL_ID}", "select": "*"})
    if not deals:
        raise RuntimeError(f"deal {DEAL_ID} not found")
    deal = deals[0]

    contract_id = deal.get("active_contract_id")
    if not contract_id:
        raise RuntimeError(f"deal {DEAL_ID} has no active contract")
    contracts = _get("contracts", {"id": f"eq.{contract_id}", "select": "*"})
    if not contracts:
        raise RuntimeError(f"contract {contract_id} not found")

    rows = _get("checklist_items",
                {"contract_id": f"eq.{contract_id}", "select": "*",
                 "order": "sort_order.asc"})
    items = [ChecklistItem.from_db_row(r) for r in rows]
    if not items:
        raise RuntimeError(f"contract {contract_id} has no checklist items")
    return deal, contracts[0], items


def record_result(result: ItemResult) -> None:
    _post("verification_results", {
        "run_id": RUN_ID,
        "checklist_item_id": result.checklist_item_id,
        "verdict": result.verdict.value,
        "detail": result.detail,
        "evidence_storage_path": result.evidence_storage_path or None,
    })


def run_group(name: str, items: list[ChecklistItem],
              ctx: VerificationContext) -> list[ItemResult]:
    """Dispatch one sub-agent; a crash inside it becomes error verdicts, not a
    crashed run, so one broken verifier can't take down the other groups."""
    try:
        module = importlib.import_module(f"agent.subagents.{name}")
        results = module.verify_items(items, ctx)
        by_id = {r.checklist_item_id: r for r in results}
        return [
            by_id.get(item.id, ItemResult(
                checklist_item_id=item.id,
                verdict=Verdict.ERROR,
                detail=f"sub-agent {name} returned no result for this item",
            ))
            for item in items
        ]
    except Exception:
        detail = f"sub-agent {name} crashed:\n{traceback.format_exc(limit=5)}"
        print(detail, file=sys.stderr)
        return [ItemResult(checklist_item_id=item.id, verdict=Verdict.ERROR,
                           detail=detail) for item in items]


def summarize(results: list[ItemResult], items: list[ChecklistItem],
              overall: OverallVerdict) -> str:
    by_verdict: dict[Verdict, int] = {}
    for r in results:
        by_verdict[r.verdict] = by_verdict.get(r.verdict, 0) + 1
    counts = ", ".join(f"{n} {v.value}" for v, n in sorted(
        by_verdict.items(), key=lambda kv: kv[0].value))
    labels = {i.id: i.label for i in items}
    failed = [labels.get(r.checklist_item_id, r.checklist_item_id)
              for r in results if r.verdict == Verdict.FAIL]
    summary = f"{overall.value}: {counts} of {len(results)} checks"
    if failed:
        summary += ". Failed: " + "; ".join(failed[:5])
    return summary


def report_completion(overall: OverallVerdict, summary: str) -> None:
    # 1. Run row is the source of truth. A failure here must not stop the
    # callback/fallback below — the deal transition matters more.
    try:
        _patch("verification_runs", {"id": f"eq.{RUN_ID}"}, {
            "status": "failed" if overall == OverallVerdict.ERROR else "completed",
            "overall_verdict": overall.value,
            "summary": summary,
            "finished_at": _now(),
        })
    except httpx.HTTPError as exc:
        print(f"failed to update verification_runs: {exc}", file=sys.stderr)

    # 2. Callback, if reachable, owns the deal transition. Only a 2xx counts
    # as delivered — a 4xx (e.g. bad secret) still leaves the deal stuck, so
    # anything else falls through to the direct transition.
    if CALLBACK_URL:
        payload = {"run_id": RUN_ID, "deal_id": DEAL_ID,
                   "overall_verdict": overall.value, "summary": summary}
        for attempt in range(3):
            try:
                resp = httpx.post(
                    CALLBACK_URL, json=payload, timeout=15,
                    headers={"Authorization": f"Bearer {CALLBACK_SECRET}"})
                if resp.status_code < 300:
                    return
                if resp.status_code < 500:
                    break  # callback rejected us; retrying won't help
            except httpx.HTTPError:
                pass
            time.sleep(2 ** attempt)
        print("callback not delivered, falling back to direct transition",
              file=sys.stderr)

    # 3. Fallback: transition the deal ourselves (guarded, idempotent).
    next_status = ("submitted" if overall == OverallVerdict.ERROR
                   else "awaiting_client_review")
    _patch("deals",
           {"id": f"eq.{DEAL_ID}", "project_status": "eq.verifying"},
           {"project_status": next_status})


def main() -> None:
    try:
        deal, contract, items = load_inputs()
        ctx = VerificationContext(
            run_id=RUN_ID,
            deal_id=DEAL_ID,
            deliverable_url=deal.get("deliverable_url") or "",
            supabase_url=SUPABASE_URL,
            supabase_service_key=SERVICE_KEY,
        )

        groups: dict[str, list[ChecklistItem]] = {}
        for item in items:
            groups.setdefault(item.sub_agent, []).append(item)

        results: list[ItemResult] = []
        for name, group_items in groups.items():
            for result in run_group(name, group_items, ctx):
                try:
                    record_result(result)
                except httpx.HTTPError as exc:
                    print(f"failed to record result: {exc}", file=sys.stderr)
                results.append(result)

        had_warnings = bool(contract.get("ambiguity_warnings"))
        overall = aggregate_verdict(results, had_warnings=had_warnings)
        report_completion(overall, summarize(results, items, overall))
        print(json.dumps({"overall_verdict": overall.value}))
    except Exception:
        detail = traceback.format_exc(limit=10)
        print(detail, file=sys.stderr)
        report_completion(OverallVerdict.ERROR, f"run crashed: {detail[-500:]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
