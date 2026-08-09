"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { BRAND } from "@/lib/brand";

// Demo persona login. Real Supabase Auth sessions (so RLS + Realtime work),
// fixed demo passwords provisioned by scripts/create-demo-users.mjs.
const DEMO_PASSWORD = "gravvhack-demo";

const PERSONAS = [
  { email: "client@demo.local", role: "Client", blurb: "Creates the deal, funds escrow, reviews evidence, approves." },
  { email: "freelancer@demo.local", role: "Freelancer", blurb: "Accepts the contract, does the work, submits the deliverable." },
  { email: "admin@demo.local", role: "Admin", blurb: "Resolves disputes. Sees everything." },
];

export default function Login() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function signIn(email: string) {
    setBusy(email);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: DEMO_PASSWORD,
    });
    if (error) {
      setError(
        "Sign-in failed. Run `node scripts/create-demo-users.mjs` to provision the demo personas."
      );
      setBusy(null);
      return;
    }
    router.push("/deals");
    router.refresh();
  }

  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-16">
      <Link href="/" className="ledger text-ink mb-10">
        {BRAND}
      </Link>
      <h1 className="text-2xl font-semibold mb-1">Choose a demo persona</h1>
      <p className="text-sm text-ink-muted mb-8">
        Sandbox environment — no real money moves.
      </p>

      <div className="w-full max-w-md space-y-3">
        {PERSONAS.map((p) => (
          <button
            key={p.email}
            onClick={() => signIn(p.email)}
            disabled={busy !== null}
            className="panel w-full text-left px-5 py-4 hover:border-cobalt transition-colors disabled:opacity-60"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{p.role}</span>
              <span className="ledger text-ink-muted">
                {busy === p.email ? "Signing in…" : p.email}
              </span>
            </div>
            <p className="text-sm text-ink-muted mt-1">{p.blurb}</p>
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-6 text-sm text-crimson max-w-md text-center">{error}</p>
      )}
    </main>
  );
}
