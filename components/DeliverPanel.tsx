"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Deal } from "@/lib/supabase/types";

// Freelancer submits the deliverable URL, then verification is dispatched.
// Delivery is URL-based by design — no file uploads in MVP scope.
export function DeliverPanel({
  deal,
  isFreelancer,
}: {
  deal: Deal;
  isFreelancer: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(deal.deliverable_url ?? "");
  const [busy, setBusy] = useState<"deliver" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canDeliver =
    isFreelancer && ["funded", "revision_requested"].includes(deal.project_status);
  const canVerify = deal.project_status === "submitted";

  async function deliver(e: React.FormEvent) {
    e.preventDefault();
    setBusy("deliver");
    setError(null);
    const res = await fetch(`/api/deals/${deal.id}/deliver`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverable_url: url }),
    });
    const json = await res.json();
    setBusy(null);
    if (!res.ok) {
      setError(json.error?.message ?? "Could not submit the deliverable.");
      return;
    }
    router.refresh();
  }

  async function verify() {
    setBusy("verify");
    setError(null);
    const res = await fetch(`/api/deals/${deal.id}/verify`, { method: "POST" });
    setBusy(null);
    if (!res.ok) {
      setError(
        res.status === 404
          ? "Verification service isn't wired up yet (agent track in progress)."
          : "Could not start verification."
      );
      return;
    }
    router.refresh();
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2 className="ledger">Deliverable</h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        {deal.deliverable_url && (
          <p className="text-sm">
            <a
              href={deal.deliverable_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cobalt underline underline-offset-2 break-all"
            >
              {deal.deliverable_url}
            </a>
          </p>
        )}

        {canDeliver && (
          <form onSubmit={deliver} className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              type="url"
              placeholder="https://your-deployed-work.example.com"
              className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-mono focus:border-cobalt"
            />
            <button
              type="submit"
              disabled={busy !== null}
              className="rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium hover:bg-cobalt-deep transition-colors disabled:opacity-60"
            >
              {busy === "deliver" ? "Submitting…" : deal.deliverable_url ? "Resubmit" : "Submit work"}
            </button>
          </form>
        )}

        {canVerify && (
          <button
            onClick={verify}
            disabled={busy !== null}
            className="rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium hover:bg-cobalt-deep transition-colors disabled:opacity-60"
          >
            {busy === "verify" ? "Dispatching…" : "Run verification"}
          </button>
        )}

        {!deal.deliverable_url && !canDeliver && (
          <p className="text-sm text-ink-muted">
            Nothing submitted yet. The freelancer can submit once escrow is funded.
          </p>
        )}

        {error && <p className="text-sm text-crimson">{error}</p>}
      </div>
    </section>
  );
}
