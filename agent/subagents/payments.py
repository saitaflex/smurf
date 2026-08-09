"""Payments sub-agent — the ONLY code path in the system that moves money.

Invoked as its own run (never as part of a verification run), and only after a
client_reviews approve/decline row exists — the API routes enforce that before
dispatching here. The AI verdict alone can never reach this code.

Flow per the plan: preview the transfer (no confirm), audit-log the preview,
then confirm, then record the transfer id on the deal. Completion is NOT polled
here — the poll-status route watches getTransaction afterwards.
"""

import argparse
import sys

sys.path.insert(0, ".")  # allow running as `python agent/subagents/payments.py` from repo root

from agent import supabase_client  # noqa: E402
from agent.tools import gravv_tools  # noqa: E402


def run(deal_id: str, direction: str) -> None:
    assert direction in ("release", "refund")

    deal = supabase_client.select_one("deals", {"id": deal_id})
    if deal is None:
        raise SystemExit(f"deal {deal_id} not found")

    expected_project_status = "approved" if direction == "release" else "declined"
    if deal["project_status"] != expected_project_status:
        raise SystemExit(
            f"{direction} requires project_status={expected_project_status}, got {deal['project_status']}"
        )
    if deal["payment_status"] != "locked":
        raise SystemExit(f"{direction} requires payment_status=locked, got {deal['payment_status']}")

    id_column = "gravv_release_transfer_id" if direction == "release" else "gravv_refund_transfer_id"
    if deal.get(id_column):
        print(f"{direction} already triggered: {deal[id_column]}")
        return

    recipient_role = "freelancer_id" if direction == "release" else "client_id"
    recipient = supabase_client.select_one("profiles", {"id": deal[recipient_role]})
    if recipient is None or not recipient.get("gravv_account_id"):
        raise SystemExit(f"recipient profile missing gravv_account_id for {direction}")

    result = gravv_tools.create_transfer(
        source_account_id=gravv_tools.ESCROW_ACCOUNT_ID or "mock_escrow_account",
        destination_account_id=recipient["gravv_account_id"],
        amount=str(deal["amount"]),
        client_reference=deal_id,
    )

    new_payment_status = "release_pending" if direction == "release" else "refund_pending"
    supabase_client.update(
        "deals",
        {"id": deal_id, "payment_status": "locked"},  # guard against concurrent trigger
        {id_column: result.id, "payment_status": new_payment_status},
    )
    supabase_client.insert(
        "audit_events",
        {
            "deal_id": deal_id,
            "actor": "agent:payments",
            "event_type": f"payment.{direction}_requested",
            "payload": {"transfer_id": result.id, "status": result.status, "mock": gravv_tools.USE_MOCK},
        },
    )
    print(f"{direction} triggered: transfer {result.id} ({result.status})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--deal-id", required=True)
    parser.add_argument("--direction", required=True, choices=["release", "refund"])
    args = parser.parse_args()
    run(args.deal_id, args.direction)
