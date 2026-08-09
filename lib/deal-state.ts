// Deal state machine — shared transition table + guards (canonical, Task 2).
// Two complementary APIs, one file (extend here, don't fork):
//  - action-keyed transitions (assertTransition) for the thin API routes
//  - status guards (canStartVerification/canRelease/canRefund/canDeliver) for
//    the verification + payments flows
// Enums live in ./supabase/types and mirror supabase/migrations/0001_init.sql.
//
// Every UPDATE that applies a transition should still be filtered on the
// expected current status (.eq('project_status', current)) so concurrent
// requests can't double-fire it.

import type { PaymentStatus, ProjectStatus } from "./supabase/types";

// project_status transitions, keyed by action. payment_status is tracked
// independently and never inferred from these — see the plan doc.
const TRANSITIONS: Record<string, { from: ProjectStatus[]; to: ProjectStatus }> = {
  confirm_contract: { from: ["draft"], to: "agreed" },
  start_kyc: { from: ["agreed"], to: "awaiting_kyc" },
  kyc_complete: { from: ["awaiting_kyc"], to: "awaiting_funding" },
  funded: { from: ["awaiting_funding"], to: "funded" },
  deliver: { from: ["funded", "revision_requested"], to: "submitted" },
  start_verification: { from: ["submitted"], to: "verifying" },
  verification_complete: { from: ["verifying"], to: "awaiting_client_review" },
  verification_errored: { from: ["verifying"], to: "submitted" }, // run crashed/timed out -> retryable
  approve: { from: ["awaiting_client_review"], to: "approved" },
  request_revision: { from: ["awaiting_client_review"], to: "revision_requested" },
  dispute: { from: ["awaiting_client_review"], to: "disputed" },
  admin_approve: { from: ["disputed"], to: "approved" },
  admin_decline: { from: ["disputed"], to: "declined" },
  cancel: {
    from: ["draft", "agreed", "awaiting_kyc", "awaiting_funding"],
    to: "cancelled",
  },
};

export type DealAction = keyof typeof TRANSITIONS;

export function canTransition(action: DealAction, current: ProjectStatus): boolean {
  const t = TRANSITIONS[action];
  return !!t && t.from.includes(current);
}

export function nextStatus(action: DealAction): ProjectStatus {
  return TRANSITIONS[action].to;
}

// Guard helper for routes: returns the target status or throws a typed error.
export class InvalidTransitionError extends Error {
  constructor(
    public action: DealAction,
    public current: ProjectStatus
  ) {
    super(`Cannot ${action} while deal is ${current}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(action: DealAction, current: ProjectStatus): ProjectStatus {
  if (!canTransition(action, current)) throw new InvalidTransitionError(action, current);
  return nextStatus(action);
}

// ---------------------------------------------------------------------------
// Status guards: transitions that also depend on payment_status. Used by the
// verification and payments flows, where "the project status allows it" isn't
// sufficient on its own.

export interface DealStatusFields {
  project_status: ProjectStatus;
  payment_status: PaymentStatus;
}

type GuardResult = { ok: true } | { ok: false; reason: string };

export function canStartVerification(deal: DealStatusFields): GuardResult {
  if (!canTransition("start_verification", deal.project_status)) {
    return { ok: false, reason: `deal is '${deal.project_status}', verification requires 'submitted'` };
  }
  if (deal.payment_status !== "locked") {
    return { ok: false, reason: `escrow is '${deal.payment_status}', verification requires 'locked'` };
  }
  return { ok: true };
}

export function canRelease(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== "approved") {
    return { ok: false, reason: `release requires 'approved', deal is '${deal.project_status}'` };
  }
  if (deal.payment_status !== "locked") {
    return { ok: false, reason: `release requires escrow 'locked', payment is '${deal.payment_status}'` };
  }
  return { ok: true };
}

export function canRefund(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== "declined") {
    return { ok: false, reason: `refund requires 'declined', deal is '${deal.project_status}'` };
  }
  if (deal.payment_status !== "locked") {
    return { ok: false, reason: `refund requires escrow 'locked', payment is '${deal.payment_status}'` };
  }
  return { ok: true };
}

export function canDeliver(deal: DealStatusFields): GuardResult {
  if (!canTransition("deliver", deal.project_status)) {
    return { ok: false, reason: `delivery requires 'funded' or 'revision_requested', deal is '${deal.project_status}'` };
  }
  return { ok: true };
}
