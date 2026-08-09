import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { assertTransition, InvalidTransitionError } from "@/lib/deal-state";

// Delivery is URL-based by design (no arbitrary file uploads in MVP scope).
// The URL is fetched only inside the verification sandbox, never by this server —
// but we still refuse obviously-internal targets here as a first SSRF filter.
const BLOCKED_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?::1\]?$)/i;

// POST /api/deals/[id]/deliver — freelancer submits the deliverable URL.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  const svc = createServiceClient();
  const found = await loadDealForActor(svc, id, profile);
  if ("response" in found) return found.response;
  const { deal } = found;

  if (profile.id !== deal.freelancer_id) {
    return apiError(403, "FORBIDDEN", "Only the freelancer on this deal can submit a deliverable.");
  }

  let next;
  try {
    next = assertTransition("deliver", deal.project_status);
  } catch (e) {
    if (e instanceof InvalidTransitionError) return apiError(409, "INVALID_STATE", e.message);
    throw e;
  }

  let body: { deliverable_url?: string };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be JSON.");
  }

  let url: URL;
  try {
    url = new URL(body.deliverable_url ?? "");
  } catch {
    return apiError(400, "VALIDATION", "Deliverable must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return apiError(400, "VALIDATION", "Deliverable URL must be http(s).");
  }
  if (BLOCKED_HOST.test(url.hostname)) {
    return apiError(400, "VALIDATION", "Deliverable URL must be publicly reachable.");
  }

  const { error } = await svc
    .from("deals")
    .update({ deliverable_url: url.toString(), project_status: next })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status);
  if (error) return apiError(500, "UPDATE_FAILED", "Could not record the deliverable.");

  await writeAudit(svc, deal.id, profile.id, "deliverable.submitted", {
    deliverable_url: url.toString(),
  });

  return NextResponse.json({ status: next, deliverable_url: url.toString() });
}
