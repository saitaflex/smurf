// POST /api/deals/[id]/fund — client funds the escrow for an agreed deal.
// Live flow (track #1) is KYC -> Gravv collection -> webhook locks funds.
// GRAVV_SIMULATE=1 compresses that to: agreed -> awaiting_funding + payment
// pending now, then the simulated webhook lands funded + locked. Without the
// flag this returns 501 and leaves state untouched.
import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { gravvSimulated, simulateCollection } from "@/lib/gravv/simulate";

const FUNDABLE = ["agreed", "awaiting_kyc", "awaiting_funding"];

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
    return apiError(403, "FORBIDDEN", "Only the client can fund the escrow.");
  }
  if (!FUNDABLE.includes(deal.project_status)) {
    return apiError(409, "INVALID_STATE",
      `funding requires one of ${FUNDABLE.join("/")}, deal is '${deal.project_status}'`);
  }
  if (deal.payment_status !== "not_created" && deal.payment_status !== "failed") {
    return apiError(409, "INVALID_STATE", `escrow already '${deal.payment_status}'`);
  }

  if (!gravvSimulated()) {
    return apiError(501, "NOT_IMPLEMENTED",
      "Live Gravv KYC/collection is not wired yet. Set GRAVV_SIMULATE=1 for the demo rail.");
  }

  const collectionId = simulateCollection(deal.id);
  const { data: updated } = await svc
    .from("deals")
    .update({
      project_status: "awaiting_funding",
      payment_status: "pending",
      gravv_collection_id: collectionId,
    })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status)
    .select("id");
  if (!updated?.length) {
    return apiError(409, "INVALID_STATE", "Deal state changed while funding — refresh.");
  }

  await writeAudit(svc, deal.id, profile.id, "payment.collection_created", {
    collection_id: collectionId,
    amount: deal.amount,
    currency: deal.currency,
    simulated: true,
  });
  return NextResponse.json({ status: "awaiting_funding", collection_id: collectionId });
}
