"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The human-in-the-loop decision. Three explicit actions, no ambiguous
// "Continue". Approve is the only path that moves money; dispute never
// auto-refunds — it locks the deal for an admin.
export function DecisionBar({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "approve" | "revision" | "dispute">("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body?: object) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(json.error?.message ?? "Action failed — refresh and retry.");
      return;
    }
    setMode("idle");
    router.refresh();
  }

  return (
    <section className="panel border-cobalt">
      <div className="panel-header">
        <h2 className="ledger">Your decision</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        {mode === "idle" && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setMode("approve")}
              className="rounded-lg bg-emerald text-white px-4 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Approve &amp; release funds
            </button>
            <button
              onClick={() => setMode("revision")}
              className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium hover:border-ink transition-colors"
            >
              Request revision
            </button>
            <button
              onClick={() => setMode("dispute")}
              className="rounded-lg border border-crimson text-crimson px-4 py-2.5 text-sm font-medium hover:bg-crimson-tint transition-colors"
            >
              Open dispute
            </button>
          </div>
        )}

        {mode === "approve" && (
          <div className="space-y-3">
            <p className="text-sm">
              Approving releases the escrow to the freelancer. This is recorded and
              cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => act("approve")}
                disabled={busy}
                className="rounded-lg bg-emerald text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
              >
                {busy ? "Recording approval…" : "Confirm: release funds"}
              </button>
              <button
                onClick={() => setMode("idle")}
                disabled={busy}
                className="rounded-lg border border-line px-4 py-2 text-sm"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {(mode === "revision" || mode === "dispute") && (
          <div className="space-y-3">
            <p className="text-sm">
              {mode === "revision"
                ? "Tell the freelancer what to fix. Funds stay protected; they resubmit against the same locked checklist."
                : "Disputes freeze the deal for an admin to resolve. Funds stay locked — this does not refund automatically."}
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={mode === "revision" ? "What needs to change…" : "Why you're disputing…"}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-cobalt"
            />
            <div className="flex gap-2">
              <button
                onClick={() =>
                  act(mode === "revision" ? "request-revision" : "dispute", { reason })
                }
                disabled={busy}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
                  mode === "revision" ? "bg-cobalt hover:bg-cobalt-deep" : "bg-crimson"
                }`}
              >
                {busy
                  ? "Sending…"
                  : mode === "revision"
                    ? "Confirm: request revision"
                    : "Confirm: open dispute"}
              </button>
              <button
                onClick={() => setMode("idle")}
                disabled={busy}
                className="rounded-lg border border-line px-4 py-2 text-sm"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-crimson">{error}</p>}
      </div>
    </section>
  );
}
