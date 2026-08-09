// Provision the three demo personas (client / freelancer / admin) as real
// Supabase Auth users and upsert their profile rows. Idempotent — safe to re-run.
//
//   node scripts/create-demo-users.mjs
//
// Reads .env.local (or env). DEMO-ONLY: fixed passwords, never use in production.

import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Minimal .env.local loader (no dotenv dependency).
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them in .env.local)");
  process.exit(1);
}

export const DEMO_PASSWORD = "gravvhack-demo";

const PERSONAS = [
  { email: "client@demo.local", role: "client", display_name: "Demo Client" },
  { email: "freelancer@demo.local", role: "freelancer", display_name: "Demo Freelancer" },
  { email: "admin@demo.local", role: "admin", display_name: "Demo Admin" },
];

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

for (const p of PERSONAS) {
  let userId;
  const { data: created, error } = await admin.auth.admin.createUser({
    email: p.email,
    password: DEMO_PASSWORD,
    email_confirm: true,
  });
  if (error) {
    // Already exists → look it up instead of failing.
    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw listErr;
    const existing = list.users.find((u) => u.email === p.email);
    if (!existing) throw error;
    userId = existing.id;
  } else {
    userId = created.user.id;
  }

  const { error: upsertErr } = await admin.from("profiles").upsert({
    id: userId,
    role: p.role,
    display_name: p.display_name,
    email: p.email,
    kyc_status: "not_started",
  });
  if (upsertErr) throw upsertErr;
  console.log(`✓ ${p.role.padEnd(10)} ${p.email}  ${userId}`);
}

console.log(`\nAll personas ready. Password for each: ${DEMO_PASSWORD}`);
