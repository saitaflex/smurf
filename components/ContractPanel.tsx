"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusChip } from "./StatusChip";
import type { Contract, StructuredRequirement, AmbiguityWarning } from "@/lib/supabase/types";

// Contract creation flow: prose → AI analysis → review → confirm & lock.
// Ambiguity warnings block confirmation until the prose is edited or the
// client explicitly acknowledges them — nothing is silently invented.
export function ContractPanel({
  dealId,
  contract,
  isClient,
  isDraft,
}: {
  dealId: string;
  contract: Contract;
  isClient: boolean;
  isDraft: boolean;
}) {
  const router = useRouter();
  const [prose, setProse] = useState(contract.requirements_raw);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{
    requirements: StructuredRequirement[];
    warnings: AmbiguityWarning[];
  } | null>(
    contract.requirements_structured.length > 0
      ? { requirements: contract.requirements_structured, warnings: contract.ambiguity_warnings }
      : null
  );

  async function confirm(acknowledge: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/contract/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requirements_raw: prose, acknowledge_warnings: acknowledge }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error?.message ?? "Analysis failed.");
      return;
    }
    setAnalysis({ requirements: json.requirements_structured, warnings: json.ambiguity_warnings });
    if (json.status === "agreed") router.refresh();
  }

  const hasWarnings = (analysis?.warnings.length ?? 0) > 0;

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="ledger">Contract · v{contract.version}</h2>
        <StatusChip
          label={contract.is_locked ? "Locked" : isDraft ? "Draft" : "Agreed"}
          tone={contract.is_locked ? "info" : isDraft ? "neutral" : "info"}
        />
      </div>

      <div className="px-5 py-4 space-y-4">
        {isDraft && isClient ? (
          <>
            <textarea
              value={prose}
              onChange={(e) => setProse(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed focus:border-cobalt"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={() => confirm(false)}
                disabled={busy}
                className="rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium hover:bg-cobalt-deep transition-colors disabled:opacity-60"
              >
                {busy ? "Analyzing…" : analysis ? "Re-analyze & confirm" : "Analyze with AI"}
              </button>
              {hasWarnings && (
                <button
                  onClick={() => confirm(true)}
                  disabled={busy}
                  className="rounded-lg border border-amber text-amber px-4 py-2 text-sm font-medium hover:bg-amber-tint transition-colors disabled:opacity-60"
                >
                  Accept warnings & lock anyway
                </button>
              )}
            </div>
            {error && <p className="text-sm text-crimson">{error}</p>}
          </>
        ) : (
          <p className="text-sm text-ink-muted whitespace-pre-wrap">{contract.requirements_raw}</p>
        )}

        {hasWarnings && (
          <div className="rounded-lg bg-amber-tint px-4 py-3 space-y-1.5">
            <p className="ledger text-amber">Ambiguity flagged — resolve before locking</p>
            {analysis!.warnings.map((w, i) => (
              <p key={i} className="text-sm text-amber">
                {w.requirement_id && <span className="font-mono">{w.requirement_id}: </span>}
                {w.message.replace(/^REQUIREMENT_AMBIGUOUS:\s*/, "")}
              </p>
            ))}
          </div>
        )}

        {analysis && analysis.requirements.length > 0 && (
          <div>
            <p className="ledger text-ink-muted mb-2">Acceptance specification</p>
            <ul className="space-y-2">
              {analysis.requirements.map((r) => (
                <li key={r.id} className="flex gap-3 text-sm">
                  <span className="font-mono text-xs text-cobalt shrink-0 pt-0.5">{r.id}</span>
                  <span>{r.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
