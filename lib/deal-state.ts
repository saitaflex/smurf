// Deal state machine — shared transition table + guards.
// NOTE (team): Task-2 owner defines the canonical version of this file per the
// role split. This is a minimal implementation to unblock the thin API routes;
// extend here (don't fork) so every route keeps importing the same guards.

import type { ProjectStatus } from "./supabase/types";

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
