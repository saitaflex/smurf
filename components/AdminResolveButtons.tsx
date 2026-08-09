"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Posts to /api/deals/[id]/admin-resolve (payments-track route). Explicit
// outcomes only — resolving a dispute is a money decision.
export function AdminResolveButtons({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(outcome: "approved" | "declined") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/admin-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.status === 404
          ? "Admin-resolve route isn't wired up yet (payments track in progress)."
          : "Could not resolve the dispute."
      );
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <div className="flex gap-2">
        <button
          onClick={() => resolve("approved")}
          disabled={busy}
          className="rounded-lg bg-emerald text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          Resolve: release to freelancer
        </button>
        <button
          onClick={() => resolve("declined")}
          disabled={busy}
          className="rounded-lg bg-crimson text-white px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          Resolve: refund client
        </button>
      </div>
      {error && <p className="text-sm text-crimson mt-2">{error}</p>}
    </div>
  );
}
