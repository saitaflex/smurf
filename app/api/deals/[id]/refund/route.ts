import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { auditEvent } from "@/lib/audit";
import { GRAVV_MOCK_MODE } from "@/lib/gravv/client";

/**
 * Refunds escrow to the client. Only reachable after project_status=declined,
 * which itself only happens via admin dispute resolution — a client "decline"
 * click alone never triggers refund (plan: decline is never automatic refund).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: deal, error: dealErr } = await db.from("deals").select("*").eq("id", id).single();
  if (dealErr || !deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });

  if (deal.project_status !== "declined") {
    return NextResponse.json({ error: `refund requires project_status=declined, got ${deal.project_status}` }, { status: 409 });
  }
  if (deal.payment_status !== "locked") {
    return NextResponse.json({ error: `refund requires payment_status=locked, got ${deal.payment_status}` }, { status: 409 });
  }
  if (deal.gravv_refund_transfer_id) {
    return NextResponse.json({ already_triggered: true, transfer_id: deal.gravv_refund_transfer_id });
  }

  if (!GRAVV_MOCK_MODE) {
    return NextResponse.json({ error: "real Gravv refund dispatch not yet wired; unset GRAVV_ESCROW_ACCOUNT_ID for mock mode" }, { status: 501 });
  }

  const transferId = `mock_transfer_${crypto.randomUUID()}`;
  const { error: updateErr } = await db
    .from("deals")
    .update({ gravv_refund_transfer_id: transferId, payment_status: "refund_pending" })
    .eq("id", id)
    .eq("payment_status", "locked");
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  await auditEvent(id, "system", "payment.refund_requested", { transfer_id: transferId, mode: "mock" });

  return NextResponse.json({ triggered: true, transfer_id: transferId, payment_status: "refund_pending" });
}
