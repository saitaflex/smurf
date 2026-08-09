import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSessionProfile, createServiceClient } from "./supabase/server";
import type { Profile, Deal } from "./supabase/types";

// Consistent error envelope: { error: { code, message } }. Never leak stack traces.
export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function requireProfile(): Promise<
  { profile: Profile } | { response: NextResponse }
> {
  const profile = await getSessionProfile();
  if (!profile) {
    return { response: apiError(401, "UNAUTHENTICATED", "Sign in to continue.") };
  }
  return { profile };
}

// Loads a deal with the service client and enforces that the caller is a
// party to it (or admin). Routes then apply their own role/state checks.
export async function loadDealForActor(
  svc: SupabaseClient,
  dealId: string,
  profile: Profile
): Promise<{ deal: Deal } | { response: NextResponse }> {
  const { data: deal, error } = await svc
    .from("deals")
    .select("*")
    .eq("id", dealId)
    .single();
  if (error || !deal) {
    return { response: apiError(404, "DEAL_NOT_FOUND", "This deal does not exist.") };
  }
  const isParty =
    deal.client_id === profile.id ||
    deal.freelancer_id === profile.id ||
    profile.role === "admin";
  if (!isParty) {
    // Same shape as not-found on purpose: don't confirm existence to outsiders (IDOR).
    return { response: apiError(404, "DEAL_NOT_FOUND", "This deal does not exist.") };
  }
  return { deal: deal as Deal };
}

export async function writeAudit(
  svc: SupabaseClient,
  dealId: string | null,
  actor: string,
  eventType: string,
  payload: Record<string, unknown> = {}
) {
  await svc.from("audit_events").insert({
    deal_id: dealId,
    actor,
    event_type: eventType,
    payload,
  });
}

export { createServiceClient };
