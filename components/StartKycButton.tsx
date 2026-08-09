"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Posts to /api/deals/[id]/start-kyc. Only shown while project_status=agreed.
// In mock mode this advances straight to awaiting_funding; see the route for why.
export function StartKycButton({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/start-kyc`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not start onboarding.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-3">
      <button
        onClick={start}
        disabled={busy}
        className="w-full rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {busy ? "Starting…" : "Start onboarding"}
      </button>
      {error && <p className="text-xs text-crimson mt-2">{error}</p>}
    </div>
  );
}
