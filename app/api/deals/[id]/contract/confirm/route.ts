import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, loadDealForActor, writeAudit, createServiceClient } from "@/lib/api-helpers";
import { assertTransition, InvalidTransitionError } from "@/lib/deal-state";
import { runPlanner } from "@/lib/planner";

// POST /api/deals/[id]/contract/confirm
// Runs the Planner over the contract prose, stores structured requirements +
// ambiguity warnings + the locked checklist, and (if warnings are resolved or
// acknowledged) moves draft → agreed. Re-runnable while still in draft.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  const svc = createServiceClient();
  const found = await loadDealForActor(svc, id, profile);
  if ("response" in found) return found.response;
  const { deal } = found;

  if (profile.id !== deal.client_id && profile.role !== "admin") {
    return apiError(403, "FORBIDDEN", "Only the client can confirm the contract.");
  }

  let nextProjectStatus;
  try {
    nextProjectStatus = assertTransition("confirm_contract", deal.project_status);
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      return apiError(409, "INVALID_STATE", e.message);
    }
    throw e;
  }

  let body: { requirements_raw?: string; acknowledge_warnings?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — re-plan existing prose
  }

  const { data: contract } = await svc
    .from("contracts")
    .select("*")
    .eq("id", deal.active_contract_id ?? "")
    .single();
  if (!contract) return apiError(500, "NO_CONTRACT", "Deal has no active contract draft.");
  if (contract.is_locked) return apiError(409, "CONTRACT_LOCKED", "Contract is locked and immutable.");

  const requirementsRaw = body.requirements_raw?.trim() || contract.requirements_raw;

  const plan = await runPlanner(requirementsRaw, deal.deliverable_type, deal.deliverable_url);

  // Persist planner output on the (still-unlocked) contract draft.
  await svc
    .from("contracts")
    .update({
      requirements_raw: requirementsRaw,
      requirements_structured: plan.requirements_structured,
      ambiguity_warnings: plan.ambiguity_warnings,
    })
    .eq("id", contract.id);

  // Replace any checklist from a previous planning pass on this draft.
  await svc.from("checklist_items").delete().eq("contract_id", contract.id);
  if (plan.checklist_items.length > 0) {
    await svc.from("checklist_items").insert(
      plan.checklist_items.map((item) => ({ ...item, contract_id: contract.id }))
    );
  }

  await writeAudit(svc, deal.id, profile.id, "contract.analyzed", {
    contract_id: contract.id,
    requirements: plan.requirements_structured.length,
    warnings: plan.ambiguity_warnings.length,
  });

  // Ambiguity gate: warnings must be resolved (edit prose) or explicitly
  // acknowledged before the contract can move forward. Never silently invented.
  if (plan.ambiguity_warnings.length > 0 && !body.acknowledge_warnings) {
    return NextResponse.json(
      {
        status: "ambiguous",
        requirements_structured: plan.requirements_structured,
        ambiguity_warnings: plan.ambiguity_warnings,
        checklist_items: plan.checklist_items,
      },
      { status: 200 }
    );
  }

  const { error: updateErr } = await svc
    .from("deals")
    .update({ project_status: nextProjectStatus })
    .eq("id", deal.id)
    .eq("project_status", deal.project_status); // optimistic guard against races
  if (updateErr) return apiError(500, "UPDATE_FAILED", "Could not confirm the contract.");

  await writeAudit(svc, deal.id, profile.id, "contract.accepted", {
    contract_id: contract.id,
    acknowledged_warnings: plan.ambiguity_warnings.length > 0,
  });

  return NextResponse.json({
    status: "agreed",
    requirements_structured: plan.requirements_structured,
    ambiguity_warnings: plan.ambiguity_warnings,
    checklist_items: plan.checklist_items,
  });
}
