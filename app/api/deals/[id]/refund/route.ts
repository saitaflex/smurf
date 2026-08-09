// POST /api/deals/[id]/refund — return escrow to the client after an admin
// resolves a dispute against the freelancer (deal 'declined' + escrow
// 'locked'). Live Gravv transfer is track #1's scope; GRAVV_SIMULATE=1
// provides the demo rail (locked -> refund_pending -> refunded).
import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { canRefund } from "@/lib/deal-state";
import { gravvSimulated, simulateTransfer } from "@/lib/gravv/simulate";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  const svc = createServiceClient();
  const found = await loadDealForActor(svc, id, profile);
  if ("response" in found) return found.response;
  const { deal } = found;

  if (profile.id !== deal.client_id && profile.role !== "admin") {
    return apiError(403, "FORBIDDEN", "Only the client (or admin) can trigger the refund.");
  }

  const guard = canRefund(deal);
  if (!guard.ok) return apiError(409, "INVALID_STATE", guard.reason);

  if (!gravvSimulated()) {
    return apiError(501, "NOT_IMPLEMENTED",
      "Live Gravv refund is not wired yet. Set GRAVV_SIMULATE=1 for the demo rail.");
  }

  const transferId = simulateTransfer(deal.id, "refund");
  const { data: updated } = await svc
    .from("deals")
    .update({ payment_status: "refund_pending", gravv_refund_transfer_id: transferId })
    .eq("id", deal.id)
    .eq("payment_status", "locked")
    .select("id");
  if (!updated?.length) {
    return apiError(409, "INVALID_STATE", "Escrow state changed while refunding — refresh.");
  }

  await writeAudit(svc, deal.id, profile.id, "payment.refund_initiated", {
    transfer_id: transferId,
    simulated: true,
  });
  return NextResponse.json({ status: "refund_pending", transfer_id: transferId });
}
