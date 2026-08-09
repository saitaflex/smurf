import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { auditEvent } from "@/lib/audit";
import { getCollection, getTransaction } from "@/lib/gravv/client";

/**
 * Admin reconciliation: re-derives payment_status from Gravv's records for
 * every id the deal knows about. Escape hatch for a missed poll or a state
 * left `unknown` — Gravv is treated as the source of truth for money state.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabaseAdmin();

  const { data: deal, error: dealErr } = await db.from("deals").select("*").eq("id", id).single();
  if (dealErr || !deal) return NextResponse.json({ error: "deal not found" }, { status: 404 });

  const observed: Record<string, unknown> = {};
  let paymentStatus: string = deal.payment_status;

  try {
    if (deal.gravv_release_transfer_id) {
      const tx = await getTransaction(deal.gravv_release_transfer_id);
      observed.release_transfer = tx;
      if (tx.status === "completed") paymentStatus = "released";
      else if (tx.status === "failed") paymentStatus = "failed";
    } else if (deal.gravv_refund_transfer_id) {
      const tx = await getTransaction(deal.gravv_refund_transfer_id);
      observed.refund_transfer = tx;
      if (tx.status === "completed") paymentStatus = "refunded";
      else if (tx.status === "failed") paymentStatus = "failed";
    } else if (deal.gravv_collection_id) {
      const collection = await getCollection(deal.gravv_collection_id);
      observed.collection = collection;
      if (collection.status === "completed") paymentStatus = "locked";
      else if (collection.status === "failed") paymentStatus = "failed";
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "resync failed";
    await auditEvent(id, "admin", "resync.error", { message });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (paymentStatus !== deal.payment_status) {
    const { error: updateErr } = await db.from("deals").update({ payment_status: paymentStatus }).eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
    await auditEvent(id, "admin", "resync.corrected", {
      from: deal.payment_status,
      to: paymentStatus,
      observed,
    });
  }

  return NextResponse.json({ payment_status: paymentStatus, corrected: paymentStatus !== deal.payment_status, observed });
}
