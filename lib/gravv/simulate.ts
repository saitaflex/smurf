// Simulated Gravv payment rail — GRAVV_SIMULATE=1 (dev/demo only).
//
// Stands in for track #1's live integration with the same observable shape:
// routes flip payment_status to the *_pending state synchronously, then a
// webhook-style completion lands a moment later and settles it — exactly how
// the real collection/transfer webhooks will behave. When the real Gravv
// client lands, these calls get replaced and nothing else changes.
//
// setTimeout-based completion only works on a long-lived server (next dev /
// node server) — one more reason this must never be enabled in production.
import { createServiceClient } from "@/lib/supabase/server";

export function gravvSimulated(): boolean {
  return process.env.GRAVV_SIMULATE === "1";
}

const COMPLETION_DELAY_MS = 2_500;

function simId(prefix: string): string {
  return `sim-${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// Escrow funding: collection created now (payment pending), "webhook" locks
// the funds and moves the project to funded shortly after.
export function simulateCollection(dealId: string): string {
  const collectionId = simId("col");
  setTimeout(async () => {
    try {
      const svc = createServiceClient();
      const { data: locked } = await svc
        .from("deals")
        .update({ payment_status: "locked", project_status: "funded" })
        .eq("id", dealId)
        .eq("payment_status", "pending")
        .eq("project_status", "awaiting_funding")
        .select("id");
      if (locked?.length) {
        await svc.from("audit_events").insert({
          deal_id: dealId,
          actor: "system",
          event_type: "payment.collection_completed",
          payload: { collection_id: collectionId, simulated: true },
        });
      }
    } catch (err) {
      console.warn("simulated collection completion failed:", err);
    }
  }, COMPLETION_DELAY_MS);
  return collectionId;
}

// Payout side: release (to freelancer) / refund (to client).
export function simulateTransfer(dealId: string, kind: "release" | "refund"): string {
  const transferId = simId(kind === "release" ? "rel" : "ref");
  const pending = kind === "release" ? "release_pending" : "refund_pending";
  const settled = kind === "release" ? "released" : "refunded";
  setTimeout(async () => {
    try {
      const svc = createServiceClient();
      const { data: done } = await svc
        .from("deals")
        .update({ payment_status: settled })
        .eq("id", dealId)
        .eq("payment_status", pending)
        .select("id");
      if (done?.length) {
        await svc.from("audit_events").insert({
          deal_id: dealId,
          actor: "system",
          event_type: `payment.${settled}`,
          payload: { transfer_id: transferId, simulated: true },
        });
      }
    } catch (err) {
      console.warn(`simulated ${kind} completion failed:`, err);
    }
  }, COMPLETION_DELAY_MS);
  return transferId;
}
