// Deal state machine — shared transition table + guards.
// Canonical file per the team role split: every route imports the same guards;
// extend here, don't fork.

import type { PaymentStatus, ProjectStatus } from "./supabase/types";

// Re-exported so payment/polling modules can import status types from here
// alongside the guards (types themselves live in supabase/types.ts).
export type { PaymentStatus, ProjectStatus };

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

// payment_status machine — separate from project_status by design ("DB says
// paid, Gravv says otherwise" is a real bug class; never infer one from the
// other). Used by the payments/polling routes.
const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  not_created: ["pending", "failed"],
  pending: ["locked", "failed"],
  locked: ["release_pending", "refund_pending"],
  release_pending: ["released", "failed", "unknown"],
  released: [],
  refund_pending: ["refunded", "failed", "unknown"],
  refunded: [],
  failed: ["pending", "release_pending", "refund_pending"], // allow retry after failure
  unknown: ["released", "refunded", "failed"], // resolved by admin resync
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) {
    throw new Error(`Invalid payment_status transition: ${from} -> ${to}`);
  }
}
