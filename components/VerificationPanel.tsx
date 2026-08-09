import { StatusChip } from "./StatusChip";
import { ITEM_VERDICT, OVERALL_VERDICT } from "@/lib/status";
import type { ChecklistItem, VerificationRun, VerificationResult } from "@/lib/supabase/types";

// Evidence-first verification view: every checklist item shows its literal
// assertion, its verdict, and (when present) the evidence behind it.
// The AI verdict is presented as evidence for the client — never as a decision.
export function VerificationPanel({
  items,
  run,
  results,
  evidenceUrls,
}: {
  items: ChecklistItem[];
  run: VerificationRun | null;
  results: VerificationResult[];
  evidenceUrls: Record<string, string>; // result id -> signed URL
}) {
  const byItem = new Map(results.map((r) => [r.checklist_item_id, r]));
  const running = run && ["queued", "running"].includes(run.status);

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="ledger">Verification</h2>
        {run?.overall_verdict ? (
          <StatusChip {...OVERALL_VERDICT[run.overall_verdict]} />
        ) : running ? (
          <StatusChip label="Running…" tone="info" />
        ) : run?.status === "timed_out" ? (
          <StatusChip label="Timed out" tone="warn" />
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-muted">
          The test checklist is generated when the contract is confirmed.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const result = byItem.get(item.id);
            const verdict = result ? ITEM_VERDICT[result.verdict] : null;
            const evidence = result ? evidenceUrls[result.id] : undefined;
            return (
              <li key={item.id}>
                <details className="group">
                  <summary className="flex items-center gap-3 px-5 py-3 cursor-pointer list-none hover:bg-paper transition-colors">
                    <span
                      className={`ledger w-6 text-center shrink-0 ${
                        verdict
                          ? verdict.tone === "success"
                            ? "text-emerald"
                            : verdict.tone === "danger"
                              ? "text-crimson"
                              : "text-amber"
                          : running
                            ? "text-cobalt animate-pulse"
                            : "text-ink-muted"
                      }`}
                    >
                      {verdict?.mark ?? (running ? "·" : "—")}
                    </span>
                    <span className="font-mono text-xs text-cobalt shrink-0">{item.requirement_id}</span>
                    <span className="text-sm flex-1 min-w-0 truncate">{item.label}</span>
                    {verdict && <StatusChip label={verdict.label} tone={verdict.tone} />}
                  </summary>
                  <div className="px-5 pb-4 pl-14 space-y-2">
                    <div>
                      <p className="ledger text-ink-muted mb-1">Assertion ({item.sub_agent})</p>
                      <pre className="text-xs font-mono bg-paper border border-line rounded-lg px-3 py-2 overflow-x-auto">
                        {JSON.stringify(item.assertion, null, 2)}
                      </pre>
                    </div>
                    {result?.detail && (
                      <div>
                        <p className="ledger text-ink-muted mb-1">Result</p>
                        <p className="text-sm">{result.detail}</p>
                      </div>
                    )}
                    {evidence && (
                      <a
                        href={evidence}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-sm text-cobalt underline underline-offset-2"
                      >
                        View evidence
                      </a>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      {run?.summary && (
        <p className="px-5 py-3 border-t border-line text-sm text-ink-muted">{run.summary}</p>
      )}
    </section>
  );
}
