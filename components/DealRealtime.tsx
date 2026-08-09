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

    // Fallback while Realtime publication isn't configured yet: light polling,
    // enabled only during active windows (verifying / awaiting webhooks).
    const interval = poll
      ? setInterval(() => {
          if (document.visibilityState === "visible") router.refresh();
        }, 5000)
      : null;

    return () => {
      supabase.removeChannel(channel);
      if (interval) clearInterval(interval);
    };
  }, [dealId, poll, router]);

  return null;
}
