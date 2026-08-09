-- Enable Realtime for the live verification UI (frontend track).
-- Realtime respects RLS, so subscribers only receive rows their session can
-- select — which is why the demo uses real Supabase Auth sessions.

alter publication supabase_realtime add table deals;
alter publication supabase_realtime add table verification_runs;
alter publication supabase_realtime add table verification_results;
