// Single source of truth for how statuses read and render.
// Tone rule: emerald = money released / verified pass only; amber = anything
// waiting on a human or a provider; crimson = failed/disputed; neutral = flow.

import type { ProjectStatus, PaymentStatus, ItemVerdict, OverallVerdict } from "./supabase/types";

export type Tone = "neutral" | "info" | "success" | "warn" | "danger";

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  agreed: { label: "Contract agreed", tone: "info" },
  awaiting_kyc: { label: "Awaiting KYC", tone: "warn" },
  awaiting_funding: { label: "Awaiting funding", tone: "warn" },
  funded: { label: "Funded", tone: "info" },
  submitted: { label: "Work submitted", tone: "info" },
  verifying: { label: "Verifying", tone: "info" },
  awaiting_client_review: { label: "Awaiting your review", tone: "warn" },
  revision_requested: { label: "Revision requested", tone: "warn" },
  disputed: { label: "Disputed", tone: "danger" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const PAYMENT_STATUS: Record<PaymentStatus, { label: string; tone: Tone; note: string }> = {
  not_created: { label: "No escrow yet", tone: "neutral", note: "Escrow is created when the contract is agreed." },
  pending: { label: "Escrow pending", tone: "warn", note: "Waiting for the deposit to arrive." },
  locked: { label: "Funds protected", tone: "info", note: "Deposited and locked. The freelancer cannot withdraw yet." },
  release_pending: { label: "Release confirming", tone: "warn", note: "Approval recorded — the payment provider is confirming the release. Funds are not lost." },
  released: { label: "Released to freelancer", tone: "success", note: "Escrow released after your approval." },
  refund_pending: { label: "Refund confirming", tone: "warn", note: "The provider is confirming the refund." },
  refunded: { label: "Refunded to client", tone: "neutral", note: "Escrow returned after resolution." },
  failed: { label: "Payment failed", tone: "danger", note: "A transfer failed. An operator has been notified — funds remain in escrow." },
  unknown: { label: "Reconciling", tone: "warn", note: "Confirming the true state with the provider." },
};

export const ITEM_VERDICT: Record<ItemVerdict, { label: string; mark: string; tone: Tone }> = {
  pass: { label: "Pass", mark: "✓", tone: "success" },
  fail: { label: "Fail", mark: "✕", tone: "danger" },
  error: { label: "Error", mark: "!", tone: "warn" },
  needs_human_review: { label: "Human review", mark: "⚑", tone: "warn" },
};

export const OVERALL_VERDICT: Record<OverallVerdict, { label: string; tone: Tone }> = {
  pass: { label: "All checks passed", tone: "success" },
  fail: { label: "Checks failed", tone: "danger" },
  pass_with_warnings: { label: "Passed with warnings", tone: "warn" },
  needs_human_review: { label: "Needs human review", tone: "warn" },
  error: { label: "Verification error", tone: "warn" },
};

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral-tint text-ink-muted",
  info: "bg-[#e8effb] text-cobalt-deep",
  success: "bg-emerald-tint text-emerald",
  warn: "bg-amber-tint text-amber",
  danger: "bg-crimson-tint text-crimson",
};
