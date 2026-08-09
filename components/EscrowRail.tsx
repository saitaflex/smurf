import { StatusChip } from "./StatusChip";
import { PAYMENT_STATUS, PROJECT_STATUS } from "@/lib/status";
import type { Deal } from "@/lib/supabase/types";

// The signature element: the deal's lifecycle rendered like a wire-transfer
// receipt. project_status drives the rail; payment_status is pinned separately
// below it — the two are independent facts and the UI never conflates them.

const STAGES: { key: string; label: string; statuses: string[] }[] = [
  { key: "contract", label: "Contract", statuses: ["draft", "agreed"] },
  { key: "escrow", label: "Escrow", statuses: ["awaiting_kyc", "awaiting_funding", "funded"] },
  { key: "deliverable", label: "Deliverable", statuses: ["submitted"] },
  { key: "verification", label: "Verification", statuses: ["verifying"] },
  { key: "review", label: "Client review", statuses: ["awaiting_client_review", "revision_requested", "disputed"] },
  { key: "settled", label: "Settled", statuses: ["approved", "declined", "cancelled"] },
];

export function EscrowRail({ deal }: { deal: Deal }) {
  const currentIdx = STAGES.findIndex((s) => s.statuses.includes(deal.project_status));
  const pay = PAYMENT_STATUS[deal.payment_status];

  return (
    <aside className="panel px-5 py-5 h-fit lg:sticky lg:top-6">
      <p className="ledger text-ink-muted mb-4">Deal {deal.id.slice(0, 8)}</p>

      <ol className="space-y-0">
        {STAGES.map((stage, i) => {
          const done = i < currentIdx;
          const current = i === currentIdx;
          return (
            <li key={stage.key} className="relative pl-6 pb-5 last:pb-0">
              {i < STAGES.length - 1 && (
                <span
                  aria-hidden
                  className={`absolute left-[5px] top-4 bottom-0 w-px ${done ? "bg-cobalt" : "bg-line"}`}
                />
              )}
              <span
                aria-hidden
                className={`absolute left-0 top-1 h-[11px] w-[11px] rounded-full border-2 ${
                  done
                    ? "bg-cobalt border-cobalt"
                    : current
                      ? "bg-surface border-cobalt"
                      : "bg-surface border-line"
                }`}
              />
              <p className={`text-sm ${current ? "font-semibold" : done ? "" : "text-ink-muted"}`}>
                {stage.label}
              </p>
              {current && (
                <div className="mt-1.5">
                  <StatusChip {...PROJECT_STATUS[deal.project_status]} />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 border-t border-line pt-4">
        <div className="flex items-baseline justify-between">
          <span className="ledger text-ink-muted">Escrow</span>
          <span className="font-mono text-lg">
            {Number(deal.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}{" "}
            <span className="text-xs">{deal.currency}</span>
          </span>
        </div>
        <div className="mt-2">
          <StatusChip label={pay.label} tone={pay.tone} />
        </div>
        <p className="text-xs text-ink-muted mt-2 leading-relaxed">{pay.note}</p>
      </div>
    </aside>
  );
}
