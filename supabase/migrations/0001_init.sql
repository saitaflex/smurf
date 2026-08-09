create extension if not exists "pgcrypto";

create table profiles (
  id uuid primary key references auth.users(id),
  role text not null check (role in ('client','freelancer','admin')),
  gravv_customer_id text,
  gravv_account_id text,
  kyc_status text not null default 'not_started'
    check (kyc_status in ('not_started','pending','completed','failed')),
  display_name text,
  email text not null,
  created_at timestamptz not null default now()
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  version int not null default 1,
  requirements_raw text not null,
  requirements_structured jsonb not null default '[]',
  ambiguity_warnings jsonb not null default '[]',
  is_locked boolean not null default false,
  created_at timestamptz not null default now()
);

create table deals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  freelancer_id uuid not null references profiles(id),
  title text not null,
  deliverable_type text not null check (deliverable_type in ('frontend','backend','image')),
  amount numeric(18,2) not null,
  currency text not null default 'USDC',
  active_contract_id uuid references contracts(id),
  project_status text not null default 'draft' check (project_status in (
    'draft','agreed','awaiting_kyc','awaiting_funding','funded',
    'submitted','verifying','awaiting_client_review',
    'revision_requested','disputed',
    'approved','declined','cancelled'
  )),
  payment_status text not null default 'not_created' check (payment_status in (
    'not_created','pending','locked','release_pending','released',
    'refund_pending','refunded','failed','unknown'
  )),
  gravv_collection_id text,
  gravv_release_transfer_id text,
  gravv_refund_transfer_id text,
  deliverable_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table contracts
  add constraint contracts_deal_fk foreign key (deal_id) references deals(id) on delete cascade;

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id) on delete cascade,
  requirement_id text not null,
  label text not null,
  sub_agent text not null check (sub_agent in ('frontend_verifier','backend_verifier','image_verifier')),
  assertion jsonb not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table verification_runs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','timed_out')),
  sandbox_id text,
  overall_verdict text check (overall_verdict in ('pass','fail','pass_with_warnings','needs_human_review','error')),
  summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table verification_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references verification_runs(id) on delete cascade,
  checklist_item_id uuid not null references checklist_items(id),
  verdict text not null check (verdict in ('pass','fail','error','needs_human_review')),
  detail text,
  evidence_storage_path text,
  created_at timestamptz not null default now()
);

create table client_reviews (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  run_id uuid references verification_runs(id),
  decided_by uuid not null references profiles(id),
  decision text not null check (decision in ('approve','request_revision','dispute')),
  reason text,
  created_at timestamptz not null default now()
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete cascade,
  actor text not null,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- No webhook event table: there is no inbound receiver in this build. All Gravv
-- state (KYC, funding, transfers) is polled on demand via the matching GET tool
-- rather than pushed, so there is nothing to dedupe or log here.

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger deals_set_updated_at
  before update on deals
  for each row execute function set_updated_at();

-- RLS
alter table profiles enable row level security;
alter table contracts enable row level security;
alter table deals enable row level security;
alter table checklist_items enable row level security;
alter table verification_runs enable row level security;
alter table verification_results enable row level security;
alter table client_reviews enable row level security;
alter table audit_events enable row level security;

create or replace function is_admin()
returns boolean as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$ language sql stable security definer;

create policy profiles_self_or_admin on profiles
  for select using (id = auth.uid() or is_admin());

create policy deals_party_or_admin on deals
  for select using (client_id = auth.uid() or freelancer_id = auth.uid() or is_admin());

create policy contracts_party_or_admin on contracts
  for select using (
    exists (
      select 1 from deals d
      where d.id = contracts.deal_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

create policy checklist_items_party_or_admin on checklist_items
  for select using (
    exists (
      select 1 from contracts c
      join deals d on d.id = c.deal_id
      where c.id = checklist_items.contract_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

create policy verification_runs_party_or_admin on verification_runs
  for select using (
    exists (
      select 1 from deals d
      where d.id = verification_runs.deal_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

create policy verification_results_party_or_admin on verification_results
  for select using (
    exists (
      select 1 from verification_runs r
      join deals d on d.id = r.deal_id
      where r.id = verification_results.run_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

create policy client_reviews_party_or_admin on client_reviews
  for select using (
    exists (
      select 1 from deals d
      where d.id = client_reviews.deal_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

create policy audit_events_party_or_admin on audit_events
  for select using (
    exists (
      select 1 from deals d
      where d.id = audit_events.deal_id
        and (d.client_id = auth.uid() or d.freelancer_id = auth.uid() or is_admin())
    )
  );

-- All writes to business tables go through API routes using the service-role key,
-- which bypasses RLS -- no client-side insert/update/delete policies are defined here
-- deliberately, so state-machine invariants stay enforced in one place (the API layer).
