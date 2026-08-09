import { notFound } from "next/navigation";
import { createUserClient, createServiceClient, getSessionProfile } from "@/lib/supabase/server";
import { EscrowRail } from "@/components/EscrowRail";
import { ContractPanel } from "@/components/ContractPanel";
import { DeliverPanel } from "@/components/DeliverPanel";
import { VerificationPanel } from "@/components/VerificationPanel";
import { DecisionBar } from "@/components/DecisionBar";
import { DealRealtime } from "@/components/DealRealtime";
import { StatusChip } from "@/components/StatusChip";
import { AdminResolveButtons } from "@/components/AdminResolveButtons";
import type {
  Deal,
  Contract,
  ChecklistItem,
  VerificationRun,
  VerificationResult,
  AuditEvent,
} from "@/lib/supabase/types";

export default async function DealWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await getSessionProfile();
  const supabase = await createUserClient();

  // RLS: returns nothing unless the caller is a party to the deal (or admin).
  const { data: dealRow } = await supabase.from("deals").select("*").eq("id", id).single();
  if (!dealRow || !profile) notFound();
  const deal = dealRow as Deal;

  const [{ data: contractRow }, { data: runRows }, { data: auditRows }] = await Promise.all([
    supabase.from("contracts").select("*").eq("id", deal.active_contract_id ?? "").single(),
    supabase
      .from("verification_runs")
      .select("*")
      .eq("deal_id", deal.id)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("audit_events")
      .select("*")
      .eq("deal_id", deal.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const contract = contractRow as Contract | null;
  const run = (runRows?.[0] ?? null) as VerificationRun | null;
  const audit = (auditRows ?? []) as AuditEvent[];

  let items: ChecklistItem[] = [];
  if (contract) {
    const { data } = await supabase
      .from("checklist_items")
      .select("*")
      .eq("contract_id", contract.id)
      .order("sort_order");
    items = (data ?? []) as ChecklistItem[];
  }

  let results: VerificationResult[] = [];
  const evidenceUrls: Record<string, string> = {};
  if (run) {
    const { data } = await supabase
      .from("verification_results")
      .select("*")
      .eq("run_id", run.id);
    results = (data ?? []) as VerificationResult[];

    // Evidence lives in a private bucket; sign short-lived URLs server-side.
    const svc = createServiceClient();
    await Promise.all(
      results
        .filter((r) => r.evidence_storage_path)
        .map(async (r) => {
          const { data: signed } = await svc.storage
            .from("verification-evidence")
            .createSignedUrl(r.evidence_storage_path!, 60 * 10);
          if (signed?.signedUrl) evidenceUrls[r.id] = signed.signedUrl;
        })
    );
  }

  const isClient = profile.id === deal.client_id;
  const isFreelancer = profile.id === deal.freelancer_id;
  const isAdmin = profile.role === "admin";
  const isDraft = deal.project_status === "draft";
  const showDecision = isClient && deal.project_status === "awaiting_client_review";
  const activeWindow = ["submitted", "verifying", "awaiting_kyc", "awaiting_funding"].includes(
    deal.project_status
  );

  return (
    <div>
      <DealRealtime dealId={deal.id} poll={activeWindow} />

      <div className="mb-6">
        <h1 className="text-xl font-semibold">{deal.title}</h1>
        <p className="ledger text-ink-muted mt-1">
          {deal.deliverable_type} · created {new Date(deal.created_at).toLocaleDateString()}
        </p>
      </div>

      <div className="grid lg:grid-cols-[280px_1fr] gap-6 items-start">
        <EscrowRail deal={deal} />

        <div className="space-y-6 min-w-0">
          {showDecision && <DecisionBar dealId={deal.id} />}

          {isAdmin && deal.project_status === "disputed" && (
            <AdminResolve dealId={deal.id} />
          )}

          {contract && (
            <ContractPanel
              dealId={deal.id}
              contract={contract}
              isClient={isClient}
              isDraft={isDraft}
            />
          )}

          <DeliverPanel deal={deal} isFreelancer={isFreelancer} />

          <VerificationPanel
            items={items}
            run={run}
            results={results}
            evidenceUrls={evidenceUrls}
          />

          <section className="panel">
            <div className="panel-header">
              <h2 className="ledger">Audit trail</h2>
            </div>
            {audit.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">No events yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {audit.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-3 px-5 py-2.5">
                    <span className="ledger text-ink-muted shrink-0 w-36">
                      {new Date(e.created_at).toLocaleTimeString()}
                    </span>
                    <span className="font-mono text-xs">{e.event_type}</span>
                    <span className="leader hidden sm:block" />
                    <span className="ledger text-ink-muted truncate max-w-40">{e.actor}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// Admin dispute resolution — posts to the payments owner's admin-resolve route.
function AdminResolve({ dealId }: { dealId: string }) {
  return (
    <section className="panel border-crimson">
      <div className="panel-header">
        <h2 className="ledger">Dispute — admin resolution</h2>
        <StatusChip label="Funds locked" tone="warn" />
      </div>
      <div className="px-5 py-4">
        <p className="text-sm text-ink-muted mb-3">
          Review the evidence and reviews below, then resolve. Approving releases
          escrow to the freelancer; declining starts a refund to the client.
        </p>
        <AdminResolveButtons dealId={dealId} />
      </div>
    </section>
  );
}
