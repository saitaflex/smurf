// Hand-written row types matching supabase/migrations/0001_init.sql.
// Regenerate with `supabase gen types typescript` once the CLI is wired up.

export type Role = "client" | "freelancer" | "admin";
export type KycStatus = "not_started" | "pending" | "completed" | "failed";
export type DeliverableType = "frontend" | "backend" | "image";

export type ProjectStatus =
  | "draft"
  | "agreed"
  | "awaiting_kyc"
  | "awaiting_funding"
  | "funded"
  | "submitted"
  | "verifying"
  | "awaiting_client_review"
  | "revision_requested"
  | "disputed"
  | "approved"
  | "declined"
  | "cancelled";

export type PaymentStatus =
  | "not_created"
  | "pending"
  | "locked"
  | "release_pending"
  | "released"
  | "refund_pending"
  | "refunded"
  | "failed"
  | "unknown";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "timed_out";
export type OverallVerdict = "pass" | "fail" | "pass_with_warnings" | "needs_human_review" | "error";
export type ItemVerdict = "pass" | "fail" | "error" | "needs_human_review";
export type SubAgent = "frontend_verifier" | "backend_verifier" | "image_verifier";
export type ReviewDecision = "approve" | "request_revision" | "dispute";

export interface Profile {
  id: string;
  role: Role;
  gravv_customer_id: string | null;
  gravv_account_id: string | null;
  kyc_status: KycStatus;
  display_name: string | null;
  email: string;
  created_at: string;
}

export interface StructuredRequirement {
  id: string; // "REQ-001"
  description: string;
  acceptance_criteria: string[];
  verification_type?: string;
}

export interface AmbiguityWarning {
  requirement_id?: string;
  message: string;
}

export interface Contract {
  id: string;
  deal_id: string;
  version: number;
  requirements_raw: string;
  requirements_structured: StructuredRequirement[];
  ambiguity_warnings: AmbiguityWarning[];
  is_locked: boolean;
  created_at: string;
}

export interface Deal {
  id: string;
  client_id: string;
  freelancer_id: string;
  title: string;
  deliverable_type: DeliverableType;
  amount: string; // numeric comes back as string
  currency: string;
  active_contract_id: string | null;
  project_status: ProjectStatus;
  payment_status: PaymentStatus;
  gravv_collection_id: string | null;
  gravv_release_transfer_id: string | null;
  gravv_refund_transfer_id: string | null;
  deliverable_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChecklistItem {
  id: string;
  contract_id: string;
  requirement_id: string;
  label: string;
  sub_agent: SubAgent;
  assertion: Record<string, unknown>;
  sort_order: number;
  created_at: string;
}

export interface VerificationRun {
  id: string;
  deal_id: string;
  status: RunStatus;
  sandbox_id: string | null;
  overall_verdict: OverallVerdict | null;
  summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface VerificationResult {
  id: string;
  run_id: string;
  checklist_item_id: string;
  verdict: ItemVerdict;
  detail: string | null;
  evidence_storage_path: string | null;
  created_at: string;
}

export interface ClientReview {
  id: string;
  deal_id: string;
  run_id: string | null;
  decided_by: string;
  decision: ReviewDecision;
  reason: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  deal_id: string | null;
  actor: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
