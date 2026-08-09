import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { assertTransition, InvalidTransitionError } from "@/lib/deal-state";

// POST /api/deals/[id]/request-revision — client sends the work back.
// Funds stay locked; the freelancer resubmits against the same locked checklist.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  const svc = createServiceClient();
  const found = await loadDealForActor(svc, id, profile);
  if ("response" in found) return found.response;
  const { deal } = found;

  if (profile.id !== deal.client_id) {
    return apiError(403, "FORBIDDEN", "Only the client can request a revision.");
  }

  let next;
  try {
    next = assertTransition("request_revision", deal.project_status);
  } catch (e) {
    if (e instanceof InvalidTransitionError) return apiError(409, "INVALID_STATE", e.message);
    throw e;
  }

  let body: { reason?: string } = {};
  try {
    body = await req.json();
  } catch {
    // reason optional
  }

  const { data: latestRun } = await svc
    .from("verification_runs")
    .select("id")
    .eq("deal_id", deal.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await svc.from("client_reviews").insert({
    deal_id: deal.id,
    run_id: latestRun?.id ?? null,
    decided_by: profile.id,
    decision: "request_revision",
    reason: body.reason?.slice(0, 2000) ?? null,
  });

  const { data: updated, error } = await svc
    .from("deals")
    .update({ project_status: next })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status)
    .select("id");
  if (error || !updated?.length) {
    return apiError(409, "INVALID_STATE", "Deal state changed — refresh and retry.");
  }

  await writeAudit(svc, deal.id, profile.id, "revision.requested", {
    reason: body.reason ?? null,
  });

  return NextResponse.json({ status: next });
}
