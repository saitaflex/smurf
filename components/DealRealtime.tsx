"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Invisible: subscribes to this deal's row + verification result inserts and
// re-renders the server page. Requires the 0002_realtime.sql publication and an
// authenticated session (Realtime respects RLS).
export function DealRealtime({ dealId, poll = false }: { dealId: string; poll?: boolean }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`deal-${dealId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "deals", filter: `id=eq.${dealId}` },
        () => router.refresh()
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "verification_results" },
        () => router.refresh()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "verification_runs", filter: `deal_id=eq.${dealId}` },
        () => router.refresh()
      )
      .subscribe();

    // Active windows (awaiting_kyc / awaiting_funding / release-pending /
    // refund-pending) wait on Gravv state that nothing pushes to us — call
    // poll-status to actually check, then refresh to pick up any change.
    // Realtime alone only re-renders on a DB row that already changed; it
    // can't cause the check that changes it.
    function checkNow() {
      fetch(`/api/deals/${dealId}/poll-status`, { method: "POST" })
        .catch(() => {})
        .finally(() => router.refresh());
    }

    let interval: ReturnType<typeof setInterval> | null = null;
    if (poll) {
      checkNow(); // don't wait a full 5s for the first check
      interval = setInterval(() => {
        if (document.visibilityState === "visible") checkNow();
      }, 5000);
    }

    return () => {
      supabase.removeChannel(channel);
      if (interval) clearInterval(interval);
    };
  }, [dealId, poll, router]);

  return null;
}
