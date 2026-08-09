import { NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { assertTransition, InvalidTransitionError } from "@/lib/deal-state";
import { GRAVV_MOCK_MODE } from "@/lib/gravv/client";

/**
 * POST /api/deals/[id]/start-kyc — client or freelancer kicks off onboarding
 * for whichever party hasn't got a Gravv customer yet.
 *
 * Mock mode (GRAVV_ESCROW_ACCOUNT_ID unset): both parties are marked
 * kyc_status=completed with a synthetic gravv_customer_id immediately, and the
 * deal advances straight to awaiting_funding — real S2S KYC review has been
 * observed sitting `pending` for 15+ minutes with no way to force it via API,
 * which is a poor fit for a live demo click-through. Same mock convention as
 * funding/release/refund.
 *
 * Real mode: not yet wired — would call createCustomer + startCustomerKycS2S
 * per party and land on awaiting_kyc for poll-status to pick up later.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  const svc = createServiceClient();
  const found = await loadDealForActor(svc, id, profile);
  if ("response" in found) return found.response;
  const { deal } = found;

  const isParty = profile.id === deal.client_id || profile.id === deal.freelancer_id;
  if (!isParty && profile.role !== "admin") {
    return apiError(403, "FORBIDDEN", "Only a party to this deal can start onboarding.");
  }
  if (deal.project_status !== "agreed") {
    return apiError(409, "INVALID_STATE", `start-kyc requires project_status=agreed, got ${deal.project_status}`);
  }

  if (!GRAVV_MOCK_MODE) {
    return apiError(501, "NOT_IMPLEMENTED", "Real Gravv KYC onboarding not yet wired; unset GRAVV_ESCROW_ACCOUNT_ID for mock mode.");
  }

  const { data: parties } = await svc
    .from("profiles")
    .select("id, gravv_customer_id, kyc_status")
    .in("id", [deal.client_id, deal.freelancer_id]);

  const toUpdate = (parties ?? []).filter((p) => p.kyc_status !== "completed" || !p.gravv_customer_id);
  for (const p of toUpdate) {
    await svc
      .from("profiles")
      .update({
        kyc_status: "completed",
        gravv_customer_id: p.gravv_customer_id ?? `mock_cust_${p.id}`,
      })
      .eq("id", p.id);
  }

  let next;
  try {
    next = assertTransition("skip_kyc", deal.project_status);
  } catch (e) {
    if (e instanceof InvalidTransitionError) return apiError(409, "INVALID_STATE", e.message);
    throw e;
  }

  const { error: updateErr } = await svc
    .from("deals")
    .update({ project_status: next })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status);
  if (updateErr) return apiError(500, "UPDATE_FAILED", "Could not advance the deal.");

  await writeAudit(svc, deal.id, profile.id, "kyc.mock_completed", {
    parties_updated: toUpdate.map((p) => p.id),
    mode: "mock",
  });

  return NextResponse.json({ status: next, mode: "mock" });
}
