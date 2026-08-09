import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { auditEvent } from "@/lib/audit";
import { pollDealStatus, type DealForPolling, type PartyForPolling } from "@/lib/gravv/poll-status";

/**
 * Polls Gravv for the deal's pending external state (KYC / funding / transfer)
 * and applies any observed transitions. Replaces the webhook receiver — the UI
 * calls this on an interval or via a "check status" button while the deal is in
 * a waiting state.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: deal, error: dealErr } = await db.from("deals").select("*").eq("id", id).single();
  if (dealErr || !deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });

  const { data: parties, error: partiesErr } = await db
    .from("profiles")
    .select("id, gravv_customer_id, kyc_status")
    .in("id", [deal.client_id, deal.freelancer_id]);
  if (partiesErr || !parties) return NextResponse.json({ error: "parties not found" }, { status: 500 });

  let outcome;
  try {
    outcome = await pollDealStatus(deal as DealForPolling, parties as PartyForPolling[]);
  } catch (e) {
    const message = e instanceof Error ? e.message : "poll failed";
    await auditEvent(id, "system", "poll_status.error", { message });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!outcome.changed) {
    return NextResponse.json({ changed: false, deal_status: deal.project_status, payment_status: deal.payment_status, observed: outcome.observed });
  }

  if (outcome.kycCompleted?.length) {
    await db.from("profiles").update({ kyc_status: "completed" }).in("id", outcome.kycCompleted);
  }

  const dealUpdate: Record<string, unknown> = {};
  if (outcome.project_status) dealUpdate.project_status = outcome.project_status;
  if (outcome.payment_status) dealUpdate.payment_status = outcome.payment_status;

  if (Object.keys(dealUpdate).length > 0) {
    const { error: updateErr } = await db.from("deals").update(dealUpdate).eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await auditEvent(id, "system", "poll_status.transition", {
    from: { project_status: deal.project_status, payment_status: deal.payment_status },
    to: dealUpdate,
    observed: outcome.observed,
  });

  return NextResponse.json({
    changed: true,
    deal_status: outcome.project_status ?? deal.project_status,
    payment_status: outcome.payment_status ?? deal.payment_status,
    observed: outcome.observed,
  });
}
