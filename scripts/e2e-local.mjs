// End-to-end flow test against the running dev server + local Supabase.
// Signs in via @supabase/ssr with a Map-backed cookie store so we hold the
// exact cookies the server expects, then drives the deal lifecycle:
// create -> plan/confirm -> (simulate funding) -> deliver -> verify ->
// wait for verdict -> approve.
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const URL_ = "http://127.0.0.1:54321";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = "http://localhost:3000";
const svc = createClient(URL_, SERVICE, { auth: { persistSession: false } });

async function cookiesFor(email) {
  const jar = new Map();
  const client = createServerClient(URL_, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: "gravvhack-demo" });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

async function api(cookie, method, path, body) {
  const resp = await fetch(APP + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await resp.json(); } catch {}
  return { status: resp.status, json };
}

const log = (step, r) => console.log(`${step}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);

const clientCookie = await cookiesFor("client@demo.local");
const freelancerCookie = await cookiesFor("freelancer@demo.local");
console.log("logins OK (client, freelancer)");

// 1. Client creates a deal (backend deliverable, prose with one vague line).
let r = await api(clientCookie, "POST", "/api/deals", {
  title: "Health API for shop",
  freelancer_email: "freelancer@demo.local",
  deliverable_type: "backend",
  amount: 250,
  requirements_raw:
    "The API endpoint /api/deals must respond with HTTP 401 for anonymous users. " +
    "The login page at /login must return HTTP 200. " +
    "The service should feel fast and professional.",
});
log("create deal", r);
if (r.status !== 200 && r.status !== 201) process.exit(1);
const dealId = r.json.deal?.id ?? r.json.id;
console.log("deal:", dealId);

// 2. Confirm contract — first pass should surface ambiguity warnings.
r = await api(clientCookie, "POST", `/api/deals/${dealId}/contract/confirm`, {});
log("confirm (expect warnings gate)", r);
r = await api(clientCookie, "POST", `/api/deals/${dealId}/contract/confirm`, { acknowledge_warnings: true });
log("confirm (acknowledged)", r);

// Replace the stub's guessed checklist with deterministic assertions against
// the app itself, so the verification outcome is provable.
const { data: deal1 } = await svc.from("deals").select("*").eq("id", dealId).single();
console.log("status after confirm:", deal1.project_status);
await svc.from("checklist_items").delete().eq("contract_id", deal1.active_contract_id);
const { error: insErr } = await svc.from("checklist_items").insert([
  { contract_id: deal1.active_contract_id, requirement_id: "REQ-001", label: "anonymous /api/deals is denied",
    sub_agent: "backend_verifier", assertion: { type: "http_status", path: "/api/deals", method: "POST", expected_status: 401 }, sort_order: 0 },
  { contract_id: deal1.active_contract_id, requirement_id: "REQ-001", label: "denial is a typed error",
    sub_agent: "backend_verifier", assertion: { type: "json_field", path: "/api/cron/sweep-stale-runs", json_path: "error", expected: "unauthorized" }, sort_order: 1 },
  { contract_id: deal1.active_contract_id, requirement_id: "REQ-002", label: "login page loads",
    sub_agent: "backend_verifier", assertion: { type: "http_status", path: "/login", expected_status: 200 }, sort_order: 2 },
]);
if (insErr) { console.log("checklist insert failed:", insErr.message); process.exit(1); }

// 3. Simulate the payments track: KYC + escrow funded (Gravv is track #1).
await svc.from("deals").update({ project_status: "funded", payment_status: "locked" }).eq("id", dealId);
console.log("simulated escrow: funded + locked");

// 4. Freelancer delivers the app itself as the deliverable URL.
r = await api(freelancerCookie, "POST", `/api/deals/${dealId}/deliver`, {
  deliverable_url: "http://localhost:3000",
  note: "done, see routes",
});
log("deliver", r);

// 5. Verify — this exercises MY route + local orchestrator dispatch.
r = await api(clientCookie, "POST", `/api/deals/${dealId}/verify`, {});
log("verify", r);
const runId = r.json.run_id;
if (!runId) process.exit(1);

// 6. Wait for the verdict (orchestrator -> results -> callback -> transition).
let run, tries = 0;
do {
  await new Promise((res) => setTimeout(res, 1500));
  ({ data: run } = await svc.from("verification_runs").select("*").eq("id", runId).single());
} while (run.status === "running" && ++tries < 40);
console.log("run:", run.status, "| verdict:", run.overall_verdict, "|", run.summary);

const { data: results } = await svc.from("verification_results").select("verdict, detail, evidence_storage_path").eq("run_id", runId);
for (const res of results ?? []) console.log("  item:", res.verdict, "-", res.detail, res.evidence_storage_path ? `[evidence: ${res.evidence_storage_path}]` : "");

let deal2, t2 = 0;
do {
  await new Promise((res) => setTimeout(res, 1000));
  ({ data: deal2 } = await svc.from("deals").select("project_status").eq("id", dealId).single());
} while (deal2.project_status === "verifying" && ++t2 < 15);
console.log("deal status after verification:", deal2.project_status);

// 7. Client approves.
r = await api(clientCookie, "POST", `/api/deals/${dealId}/approve`, {});
log("approve", r);
const { data: deal3 } = await svc.from("deals").select("project_status, payment_status").eq("id", dealId).single();
console.log("FINAL:", JSON.stringify(deal3));
