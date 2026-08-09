"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser client: anon key, RLS-enforced. Used for auth (demo persona login)
// and Realtime subscriptions on the deal workspace.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
