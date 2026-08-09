/**
 * Gravv REST client — GET/status-polling only.
 *
 * Money movement (createCollection / createTransfer) lives exclusively in
 * agent/subagents/payments.py per the plan's boundary; this module only reads
 * state back so routes can poll. Endpoint paths verified live against
 * api.gravv.xyz (see GRAVV_API.md + session notes):
 *   - GET /v1/customers/{id}/kyc/status
 *   - GET /v1/transactions (list)
 *   - GET /v1/collections/{id}
 *
 * Mock mode: when GRAVV_ESCROW_ACCOUNT_ID is unset, synthetic ids created by
 * the mock provider (prefix "mock_") resolve as instantly completed, so the
 * whole flow works with no real Gravv account. Same toggle as
 * agent/tools/gravv_tools.py.
 */

const BASE = "https://api.gravv.xyz";

export const GRAVV_MOCK_MODE = !process.env.GRAVV_ESCROW_ACCOUNT_ID;

function headers(): Record<string, string> {
  const key = process.env.GRAVV_API_KEY;
  const pub = process.env.GRAVV_PUBLIC_KEY;
  if (!key || !pub) throw new Error("Missing GRAVV_API_KEY or GRAVV_PUBLIC_KEY");
  return {
    "Api-Key": key,
    "X-Client-Public-Key": pub,
    "X-Environment": "sandbox",
  };
}

async function gravvGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers(), cache: "no-store" });
  const body = (await res.json()) as { data: T; error: string | null };
  if (!res.ok || body.error) {
    throw new Error(`Gravv GET ${path} failed (${res.status}): ${body.error ?? "unknown"}`);
  }
  return body.data;
}

export type KycReviewStatus = "pending" | "completed";

export async function getKycStatus(customerId: string): Promise<{ reviewStatus: KycReviewStatus; reviewResult?: unknown }> {
  if (GRAVV_MOCK_MODE) return { reviewStatus: "completed" };
  return gravvGet(`/v1/customers/${customerId}/kyc/status`);
}

export interface GravvTransaction {
  id: string;
  status: string;
  client_reference?: string;
  [key: string]: unknown;
}

export async function getTransaction(transactionId: string): Promise<GravvTransaction> {
  if (GRAVV_MOCK_MODE || transactionId.startsWith("mock_")) {
    return { id: transactionId, status: "completed" };
  }
  return gravvGet(`/v1/transactions/${transactionId}`);
}

export async function listTransactions(page = 1, limit = 20): Promise<{ items: GravvTransaction[] }> {
  if (GRAVV_MOCK_MODE) return { items: [] };
  return gravvGet(`/v1/transactions?page=${page}&limit=${limit}`);
}

export async function getCollection(collectionId: string): Promise<GravvTransaction> {
  if (GRAVV_MOCK_MODE || collectionId.startsWith("mock_")) {
    return { id: collectionId, status: "completed" };
  }
  return gravvGet(`/v1/collections/${collectionId}`);
}

/**
 * Initiates escrow funding. Preview-then-confirm per Gravv's money-moving
 * convention (see agent/tools/gravv_tools.py for the same pattern on the
 * Python side, used by release/refund). Mock mode returns an instantly
 * "completed" synthetic collection so the flow is demoable without a real
 * Gravv escrow account.
 */
export async function createCollection(args: {
  customerId: string;
  amount: string;
  currency: string;
  clientReference: string;
  metadata: Record<string, unknown>;
}): Promise<GravvTransaction> {
  if (GRAVV_MOCK_MODE) {
    return { id: `mock_collection_${crypto.randomUUID()}`, status: "completed" };
  }

  const escrowAccountId = process.env.GRAVV_ESCROW_ACCOUNT_ID!;
  const body = {
    customer_id: args.customerId,
    client_customer_id: args.customerId,
    amount: args.amount,
    currency: args.currency,
    country: "US",
    client_reference: args.clientReference,
    metadata: args.metadata,
    source: { source_type: "external", methods: ["card"] },
    destination: { destination_type: "internal_account", id: escrowAccountId },
  };

  // Preview.
  const previewRes = await fetch(`${BASE}/v1/collections`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const preview = (await previewRes.json()) as { data: GravvTransaction; error: string | null };
  if (!previewRes.ok || preview.error) {
    throw new Error(`Gravv createCollection preview failed: ${preview.error ?? previewRes.status}`);
  }

  // Confirm.
  const confirmRes = await fetch(`${BASE}/v1/collections`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ ...body, confirm: true }),
  });
  const confirmed = (await confirmRes.json()) as { data: GravvTransaction; error: string | null };
  if (!confirmRes.ok || confirmed.error) {
    throw new Error(`Gravv createCollection confirm failed: ${confirmed.error ?? confirmRes.status}`);
  }
  return confirmed.data;
}
