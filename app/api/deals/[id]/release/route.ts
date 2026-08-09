import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { auditEvent } from "@/lib/audit";
import { GRAVV_MOCK_MODE } from "@/lib/gravv/client";

/**
 * Releases escrow to the freelancer. Only reachable after a client_reviews
 * approve row exists (or admin dispute-resolution set project_status=approved).
 * Money movement itself belongs to agent/subagents/payments.py; in mock mode
 * (GRAVV_ESCROW_ACCOUNT_ID unset) we synthesize the transfer so the flow is
 * demonstrable end-to-end, and poll-status resolves it to `released`.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: deal, error: dealErr } = await db.from("deals").select("*").eq("id", id).single();
  if (dealErr || !deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });

  if (deal.project_status !== "approved") {
    return NextResponse.json({ error: `release requires project_status=approved, got ${deal.project_status}` }, { status: 409 });
  }
  if (deal.payment_status !== "locked") {
    return NextResponse.json({ error: `release requires payment_status=locked, got ${deal.payment_status}` }, { status: 409 });
  }
  // Idempotency: a transfer id already recorded means release was already triggered.
  if (deal.gravv_release_transfer_id) {
    return NextResponse.json({ already_triggered: true, transfer_id: deal.gravv_release_transfer_id });
  }

  const { data: approval } = await db
    .from("client_reviews")
    .select("id, decision")
    .eq("deal_id", id)
    .eq("decision", "approve")
    .limit(1)
    .maybeSingle();
  if (!approval) {
    return NextResponse.json({ error: "no approve decision recorded for this deal" }, { status: 409 });
  }

  if (!GRAVV_MOCK_MODE) {
    // Real path: dispatch the Payments sub-agent ADK run (owns createTransfer
    // preview->confirm). Sandbox dispatch infra is owned by the agent-core
    // workstream; wire the call here once lib/sandbox exposes it.
    return NextResponse.json({ error: "real Gravv release dispatch not yet wired; unset GRAVV_ESCROW_ACCOUNT_ID for mock mode" }, { status: 501 });
  }

  const transferId = `mock_transfer_${crypto.randomUUID()}`;
  const { error: updateErr } = await db
    .from("deals")
    .update({ gravv_release_transfer_id: transferId, payment_status: "release_pending" })
    .eq("id", id)
    .eq("payment_status", "locked"); // guard against concurrent double-trigger
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  await auditEvent(id, "system", "payment.release_requested", {
    transfer_id: transferId,
    mode: "mock",
    approval_id: approval.id,
  });

  return NextResponse.json({ triggered: true, transfer_id: transferId, payment_status: "release_pending" });
}
