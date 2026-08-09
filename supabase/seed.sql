-- Demo seed data. Run after 0001_init.sql on a fresh local/dev database.
-- Assumes auth.users rows for these ids already exist (create via Supabase Auth first,
-- e.g. `supabase auth admin` or the dashboard, then update the ids below to match).

insert into profiles (id, role, display_name, email, kyc_status) values
  ('00000000-0000-0000-0000-000000000001', 'client', 'Demo Client', 'client@demo.local', 'not_started'),
  ('00000000-0000-0000-0000-000000000002', 'freelancer', 'Demo Freelancer', 'freelancer@demo.local', 'not_started'),
  ('00000000-0000-0000-0000-000000000003', 'admin', 'Demo Admin', 'admin@demo.local', 'not_started')
on conflict (id) do nothing;
