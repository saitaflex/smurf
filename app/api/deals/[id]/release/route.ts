// POST /api/deals/[id]/release — release escrow to the freelancer.
// Called by the approve route's hand-off (or retried directly). Requires the
// deal approved + escrow locked. Live Gravv transfer is track #1's scope;
// until it lands, GRAVV_SIMULATE=1 provides the same observable behavior
// (locked -> release_pending now, -> released via simulated webhook).
import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { canRelease } from "@/lib/deal-state";
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
    return apiError(403, "FORBIDDEN", "Only the client (or admin) can release escrow.");
  }

  const guard = canRelease(deal);
  if (!guard.ok) return apiError(409, "INVALID_STATE", guard.reason);

  if (!gravvSimulated()) {
    // Real Gravv transfer not implemented yet (track #1). State is untouched,
    // so this stays retryable once the live integration lands.
    return apiError(501, "NOT_IMPLEMENTED",
      "Live Gravv release is not wired yet. Set GRAVV_SIMULATE=1 for the demo rail.");
  }

  const transferId = simulateTransfer(deal.id, "release");
  const { data: updated } = await svc
    .from("deals")
    .update({ payment_status: "release_pending", gravv_release_transfer_id: transferId })
    .eq("id", deal.id)
    .eq("payment_status", "locked")
    .select("id");
  if (!updated?.length) {
    return apiError(409, "INVALID_STATE", "Escrow state changed while releasing — refresh.");
  }

  await writeAudit(svc, deal.id, profile.id, "payment.release_initiated", {
    transfer_id: transferId,
    simulated: true,
  });
  return NextResponse.json({ status: "release_pending", transfer_id: transferId });
}
