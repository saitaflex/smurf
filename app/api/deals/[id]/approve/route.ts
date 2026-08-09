import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { assertTransition, InvalidTransitionError } from "@/lib/deal-state";

// POST /api/deals/[id]/approve — the client's human-in-the-loop decision.
// Records a client_reviews row (the sole trigger for money movement), flips
// project_status, then asks the release route (payments owner) to start the
// Gravv release. Payment settlement is confirmed by webhook, not here.
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
    return apiError(403, "FORBIDDEN", "Only the client can approve this deal.");
  }

  let next;
  try {
    next = assertTransition("approve", deal.project_status);
  } catch (e) {
    if (e instanceof InvalidTransitionError) return apiError(409, "INVALID_STATE", e.message);
    throw e;
  }

  const { data: latestRun } = await svc
    .from("verification_runs")
    .select("id")
    .eq("deal_id", deal.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Idempotency: one approve per deal. The optimistic status guard below is the
  // real gate; a second click lands on project_status=approved and 409s above.
  const { error: reviewErr } = await svc.from("client_reviews").insert({
    deal_id: deal.id,
    run_id: latestRun?.id ?? null,
    decided_by: profile.id,
    decision: "approve",
  });
  if (reviewErr) return apiError(500, "REVIEW_FAILED", "Could not record your approval.");

  const { data: updated, error: updateErr } = await svc
    .from("deals")
    .update({ project_status: next })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status)
    .select("id");
  if (updateErr || !updated?.length) {
    return apiError(409, "INVALID_STATE", "Deal state changed while approving — refresh and retry.");
  }

  await writeAudit(svc, deal.id, profile.id, "client.approved", { run_id: latestRun?.id ?? null });

  // Hand off to the payments owner's route. Forward the caller's cookies so it
  // re-authenticates the same user. Failure here is non-fatal: the approval is
  // durably recorded, and release can be retried from the UI/admin.
  let releaseTriggered = false;
  try {
    const res = await fetch(new URL(`/api/deals/${deal.id}/release`, req.nextUrl.origin), {
      method: "POST",
      headers: { cookie: req.headers.get("cookie") ?? "" },
    });
    releaseTriggered = res.ok;
    if (!res.ok) {
      await writeAudit(svc, deal.id, "system", "payment.release_trigger_failed", {
        status: res.status,
      });
    }
  } catch {
    await writeAudit(svc, deal.id, "system", "payment.release_trigger_failed", {
      reason: "release route unreachable (not implemented yet?)",
    });
  }

  return NextResponse.json({ status: next, release_triggered: releaseTriggered });
}
