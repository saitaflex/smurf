import { NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { createCollection } from "@/lib/gravv/client";

/**
 * POST /api/deals/[id]/fund — client initiates escrow funding.
 *
 * Only sets payment_status here (not project_status) — same convention as
 * release/refund. project_status moves funded->... only once poll-status (or
 * the resync route) observes the collection as completed, matching the
 * separate-machines rule in lib/deal-state.ts.
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

  if (profile.id !== deal.client_id) {
    return apiError(403, "FORBIDDEN", "Only the client on this deal can fund escrow.");
  }
  if (deal.project_status !== "awaiting_funding") {
    return apiError(409, "INVALID_STATE", `Funding requires project_status=awaiting_funding, got ${deal.project_status}`);
  }
  if (deal.gravv_collection_id) {
    return NextResponse.json({ already_triggered: true, collection_id: deal.gravv_collection_id });
  }

  const { data: clientProfile } = await svc
    .from("profiles")
    .select("gravv_customer_id")
    .eq("id", deal.client_id)
    .single();
  if (!clientProfile?.gravv_customer_id) {
    return apiError(409, "NOT_ONBOARDED", "Client has no Gravv customer record yet — complete KYC first.");
  }

  let collection;
  try {
    collection = await createCollection({
      customerId: clientProfile.gravv_customer_id,
      amount: String(deal.amount),
      currency: deal.currency,
      clientReference: deal.id,
      metadata: { deal_id: deal.id },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "funding failed";
    await writeAudit(svc, deal.id, profile.id, "payment.fund_error", { message });
    return apiError(502, "GRAVV_ERROR", message);
  }

  const { error: updateErr } = await svc
    .from("deals")
    .update({ gravv_collection_id: collection.id, payment_status: "pending" })
    .eq("id", deal.id)
    .eq("payment_status", deal.payment_status); // guard against concurrent double-trigger

  if (updateErr) return apiError(500, "UPDATE_FAILED", "Could not record the funding collection.");

  await writeAudit(svc, deal.id, profile.id, "payment.fund_requested", {
    collection_id: collection.id,
    status: collection.status,
  });

  return NextResponse.json({ triggered: true, collection_id: collection.id, payment_status: "pending" });
}
