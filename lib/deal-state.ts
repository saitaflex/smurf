// Shared deal state machine. Every route that mutates a deal's status must
// check these guards before writing, and every UPDATE should be filtered on
// the expected current status (.eq('project_status', from)) so concurrent
// requests can't double-fire a transition.
//
// Enums mirror the check constraints in supabase/migrations/0001_init.sql —
// that file is the source of truth.

export type ProjectStatus =
  | 'draft'                  // client wrote prose, contract not yet agreed
  | 'agreed'                 // both parties agreed, checklist locked
  | 'awaiting_kyc'           // Gravv KYC pending
  | 'awaiting_funding'       // escrow collection not completed
  | 'funded'                 // escrow locked, freelancer working
  | 'submitted'              // deliverable submitted, verification not started
  | 'verifying'              // sandbox run in flight
  | 'awaiting_client_review' // verdict ready, client must approve/revise/dispute
  | 'revision_requested'     // client sent it back, freelancer redelivers
  | 'disputed'               // escalated, admin resolves
  | 'approved'               // client approved, release flows via payment_status
  | 'declined'               // resolved against freelancer, refund flows via payment_status
  | 'cancelled';             // abandoned before funding

export type PaymentStatus =
  | 'not_created'
  | 'pending'          // collection created, waiting on Gravv webhook
  | 'locked'           // funds held in escrow
  | 'release_pending'  // release transfer in flight
  | 'released'
  | 'refund_pending'
  | 'refunded'
  | 'failed'
  | 'unknown';

const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ['agreed', 'cancelled'],
  agreed: ['awaiting_kyc', 'awaiting_funding', 'cancelled'],
  awaiting_kyc: ['awaiting_funding', 'cancelled'],
  awaiting_funding: ['funded', 'cancelled'],
  funded: ['submitted'],
  submitted: ['verifying'],
  verifying: ['awaiting_client_review', 'submitted'], // back to submitted = run errored, retry allowed
  awaiting_client_review: ['approved', 'revision_requested', 'disputed'],
  revision_requested: ['submitted'],
  disputed: ['approved', 'declined'], // admin resolution
  approved: [],  // terminal for project; payment_status carries the release
  declined: [],  // terminal for project; payment_status carries the refund
  cancelled: [],
};

export function canTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface DealStatusFields {
  project_status: ProjectStatus;
  payment_status: PaymentStatus;
}

type GuardResult = { ok: true } | { ok: false; reason: string };

export function canStartVerification(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== 'submitted') {
    return { ok: false, reason: `deal is '${deal.project_status}', verification requires 'submitted'` };
  }
  if (deal.payment_status !== 'locked') {
    return { ok: false, reason: `escrow is '${deal.payment_status}', verification requires 'locked'` };
  }
  return { ok: true };
}

export function canRelease(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== 'approved') {
    return { ok: false, reason: `release requires 'approved', deal is '${deal.project_status}'` };
  }
  if (deal.payment_status !== 'locked') {
    return { ok: false, reason: `release requires escrow 'locked', payment is '${deal.payment_status}'` };
  }
  return { ok: true };
}

export function canRefund(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== 'declined') {
    return { ok: false, reason: `refund requires 'declined', deal is '${deal.project_status}'` };
  }
  if (deal.payment_status !== 'locked') {
    return { ok: false, reason: `refund requires escrow 'locked', payment is '${deal.payment_status}'` };
  }
  return { ok: true };
}

export function canDeliver(deal: DealStatusFields): GuardResult {
  if (deal.project_status !== 'funded' && deal.project_status !== 'revision_requested') {
    return { ok: false, reason: `delivery requires 'funded' or 'revision_requested', deal is '${deal.project_status}'` };
  }
  return { ok: true };
}
