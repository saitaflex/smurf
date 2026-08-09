import { getCollection, getKycStatus, getTransaction } from "@/lib/gravv/client";
import type { PaymentStatus, ProjectStatus } from "@/lib/deal-state";

export interface DealForPolling {
  id: string;
  project_status: ProjectStatus;
  payment_status: PaymentStatus;
  gravv_collection_id: string | null;
  gravv_release_transfer_id: string | null;
  gravv_refund_transfer_id: string | null;
}

export interface PartyForPolling {
  id: string;
  gravv_customer_id: string | null;
  kyc_status: string;
}

export interface PollOutcome {
  changed: boolean;
  project_status?: ProjectStatus;
  payment_status?: PaymentStatus;
  kycCompleted?: string[]; // profile ids whose kyc_status should flip to completed
  observed: Record<string, unknown>;
}

/**
 * One poll pass for a deal. Pure decision logic — reads Gravv, returns what
 * should change; the route applies DB writes + audit events. Replaces the
 * webhook receiver: instead of Gravv pushing state, we pull it on demand.
 */
export async function pollDealStatus(deal: DealForPolling, parties: PartyForPolling[]): Promise<PollOutcome> {
  switch (deal.project_status) {
    case "awaiting_kyc": {
      const pendingParties = parties.filter((p) => p.kyc_status !== "completed");
      const nowCompleted: string[] = [];
      for (const p of pendingParties) {
        if (!p.gravv_customer_id) continue;
        const status = await getKycStatus(p.gravv_customer_id);
        if (status.reviewStatus === "completed") nowCompleted.push(p.id);
      }
      const allDone = pendingParties.every((p) => nowCompleted.includes(p.id));
      if (allDone) {
        return {
          changed: true,
          project_status: "awaiting_funding",
          kycCompleted: nowCompleted,
          observed: { kyc: "all parties completed" },
        };
      }
      return { changed: nowCompleted.length > 0, kycCompleted: nowCompleted, observed: { kyc: "still pending" } };
    }

    case "awaiting_funding": {
      if (!deal.gravv_collection_id) return { changed: false, observed: { funding: "no collection initiated yet" } };
      const collection = await getCollection(deal.gravv_collection_id);
      if (collection.status === "completed") {
        return {
          changed: true,
          project_status: "funded",
          payment_status: "locked",
          observed: { collection },
        };
      }
      if (collection.status === "failed") {
        return { changed: true, payment_status: "failed", observed: { collection } };
      }
      return { changed: false, observed: { collection } };
    }

    default:
      break;
  }

  // Payment-status polling is independent of project status (separate machines).
  if (deal.payment_status === "release_pending" && deal.gravv_release_transfer_id) {
    const tx = await getTransaction(deal.gravv_release_transfer_id);
    if (tx.status === "completed") return { changed: true, payment_status: "released", observed: { transfer: tx } };
    if (tx.status === "failed") return { changed: true, payment_status: "failed", observed: { transfer: tx } };
    return { changed: false, observed: { transfer: tx } };
  }

  if (deal.payment_status === "refund_pending" && deal.gravv_refund_transfer_id) {
    const tx = await getTransaction(deal.gravv_refund_transfer_id);
    if (tx.status === "completed") return { changed: true, payment_status: "refunded", observed: { transfer: tx } };
    if (tx.status === "failed") return { changed: true, payment_status: "failed", observed: { transfer: tx } };
    return { changed: false, observed: { transfer: tx } };
  }

  return { changed: false, observed: { note: "nothing to poll in current state" } };
}
