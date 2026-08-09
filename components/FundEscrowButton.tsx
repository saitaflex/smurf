"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Posts to /api/deals/[id]/fund. Only shown to the client while
// project_status=awaiting_funding and no collection has been created yet.
export function FundEscrowButton({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fund() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/fund`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not start funding.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-3">
      <button
        onClick={fund}
        disabled={busy}
        className="w-full rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {busy ? "Starting…" : "Fund escrow"}
      </button>
      {error && <p className="text-xs text-crimson mt-2">{error}</p>}
    </div>
  );
}
