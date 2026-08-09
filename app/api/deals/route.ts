import { NextRequest, NextResponse } from "next/server";
import { apiError, requireProfile, writeAudit, createServiceClient } from "@/lib/api-helpers";

// POST /api/deals — client creates a draft deal + contract v1 (requirements prose).
export async function POST(req: NextRequest) {
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;
  const { profile } = auth;

  if (profile.role !== "client" && profile.role !== "admin") {
    return apiError(403, "FORBIDDEN", "Only clients can create deals.");
  }

  let body: {
    title?: string;
    freelancer_email?: string;
    deliverable_type?: string;
    amount?: number;
    requirements_raw?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "INVALID_JSON", "Request body must be JSON.");
  }

  const { title, freelancer_email, deliverable_type, amount, requirements_raw } = body;
  if (!title?.trim()) return apiError(400, "VALIDATION", "Title is required.");
  if (!requirements_raw?.trim() || requirements_raw.trim().length < 20) {
    return apiError(400, "VALIDATION", "Describe the requirements (at least a few sentences).");
  }
  if (!["frontend", "backend", "image"].includes(deliverable_type ?? "")) {
    return apiError(400, "VALIDATION", "Deliverable type must be frontend, backend, or image.");
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) {
    return apiError(400, "VALIDATION", "Amount must be a positive number.");
  }

  const svc = createServiceClient();

  const { data: freelancer } = await svc
    .from("profiles")
    .select("id, role")
    .eq("email", freelancer_email ?? "")
    .single();
  if (!freelancer || freelancer.role !== "freelancer") {
    return apiError(400, "FREELANCER_NOT_FOUND", "No freelancer account with that email.");
  }

  const { data: deal, error: dealErr } = await svc
    .from("deals")
    .insert({
      client_id: profile.id,
      freelancer_id: freelancer.id,
      title: title.trim(),
      deliverable_type,
      amount: amt,
      project_status: "draft",
      payment_status: "not_created",
    })
    .select("*")
    .single();
  if (dealErr || !deal) {
    return apiError(500, "DEAL_CREATE_FAILED", "Could not create the deal. Try again.");
  }

  const { data: contract, error: contractErr } = await svc
    .from("contracts")
    .insert({
      deal_id: deal.id,
      version: 1,
      requirements_raw: requirements_raw.trim(),
    })
    .select("*")
    .single();
  if (contractErr || !contract) {
    return apiError(500, "CONTRACT_CREATE_FAILED", "Deal created but contract draft failed.");
  }

  await svc.from("deals").update({ active_contract_id: contract.id }).eq("id", deal.id);
  await writeAudit(svc, deal.id, profile.id, "contract.created", {
    contract_id: contract.id,
    version: 1,
  });

  return NextResponse.json({ deal: { ...deal, active_contract_id: contract.id } }, { status: 201 });
}
