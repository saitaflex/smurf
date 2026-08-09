// Service-role Supabase client — bypasses RLS. Server-side only: import this
// exclusively from API routes / server code, never from anything that ships
// to the browser. (Track #4 owns lib/supabase/{client,server,types}.ts for
// the RLS-protected clients.)
import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
