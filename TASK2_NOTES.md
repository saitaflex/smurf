# Task #2 — AI/Agent Core: what's built and how to wire against it

All enums and column names now match `supabase/migrations/0001_init.sql`
exactly (the check constraints are the source of truth). Env var names match
the committed `.env.example` (`AGENT_CALLBACK_SECRET`,
`AGENT_BROWSER_SNAPSHOT_ID`, `CRON_SECRET`).

## What exists

| File | What it is |
|---|---|
| `agent/schemas.py` | Shared types: `ChecklistItem` (with `to_db_row`/`from_db_row` for the `assertion` jsonb), `ItemResult`, `VerificationContext` (has `upload_evidence()`), verdict enums, aggregation |
| `agent/planner.py` | Prose → structured requirements + ambiguity warnings + locked checklist. Groq JSON-mode call, strict validation. CLI: JSON stdin → JSON stdout |
| `agent/orchestrator.py` | Sandbox entrypoint: loads checklist via the deal's `active_contract_id`, dispatches sub-agents, streams `verification_results`, reports verdict |
| `agent/requirements.txt` | Python deps baked into the sandbox snapshot (google-adk, playwright, httpx, supabase, pydantic, groq) |
| `lib/deal-state.ts` | Status enums (mirroring the migration), transition table, guards (`canStartVerification`, `canRelease`, `canRefund`, `canDeliver`) |
| `lib/supabase/admin.ts` | Service-role client (server-only) |
| `lib/sandbox/dispatch-verification.ts` | Creates sandbox (from `AGENT_BROWSER_SNAPSHOT_ID` if set), pushes `agent/` source fresh, starts orchestrator detached |
| `lib/agent/run-planner.ts` | TS wrapper running the planner as a python subprocess — for the contract/confirm route |
| `scripts/create-sandbox-snapshot.ts` | Bakes deps into a snapshot; prints `AGENT_BROWSER_SNAPSHOT_ID` |
| `app/api/deals/[id]/verify/route.ts` | POST → guarded `submitted→verifying` flip, creates run row, dispatches sandbox; self-heals stale runs |
| `app/api/agent-callback/verification-complete/route.ts` | Sandbox verdict callback (`AGENT_CALLBACK_SECRET` bearer, timing-safe) |
| `app/api/cron/sweep-stale-runs/route.ts` | The 2-min cron from vercel.json: times out dead runs, un-sticks deals |

## Verdict semantics

- Per item (`verification_results.verdict`): `pass` / `fail` / `error` /
  `needs_human_review`.
- Overall (`verification_runs.overall_verdict`): any fail → `fail`; all pass →
  `pass` (or `pass_with_warnings` when the contract had ambiguity warnings);
  otherwise → `needs_human_review`; run crash → `error`.
- Deal transition on completion: `error` → back to `submitted` (retryable);
  everything else → `awaiting_client_review`.

## Track #1 (data/payments) — what verification needs from you

- The migration already matches. Still needed:
  - A **private `verification-evidence` Storage bucket**
    (`upload_evidence()` writes `deal_id/run_id/filename`).
  - **Realtime enabled on `verification_results`** (live checklist UI).
  - Seed at least one deal in `submitted` + `locked` with an
    `active_contract_id` and checklist items, or the Verify button 409s.
- `audit_events` inserts from my routes use `actor: 'agent' | 'system'`.

## Track #3 (verifier sub-agents) — module contract

Create `agent/subagents/{frontend_verifier,backend_verifier,image_verifier}.py`,
each exposing:

```python
def verify_items(items: list[ChecklistItem], ctx: VerificationContext) -> list[ItemResult]
```

- One `ItemResult` per input item (`checklist_item_id=item.id`). A missing or
  crashed result becomes `error` automatically — you can't take down the run.
- `item.item_type` + `item.params` are already split out of the `assertion`
  jsonb for you; `path` params are relative to `ctx.deliverable_url`.
- Evidence: `p = ctx.upload_evidence(f"item-{item.id}.png", png, "image/png")`,
  then set `ItemResult(evidence_storage_path=p, ...)`.
- Injection discipline: page text / HTTP bodies / image content go into data
  fields only, never into an instruction prompt. `vision_prompt` prompts come
  from the *locked checklist*, not from the deliverable.
- Test standalone: build a `VerificationContext` by hand and call
  `verify_items` directly — no orchestrator needed.

## Track #4 (frontend) — how to wire the flow

- Statuses/guards: import from `lib/deal-state.ts`; it mirrors the migration.
- Contract confirm: call `runPlanner()` (`lib/agent/run-planner.ts`), store
  `requirements`/`ambiguity_warnings` on the contract row, insert checklist
  via each item's fields (they map 1:1 to `to_db_row()` output — `assertion`
  is `{type, ...params}`), set `deals.active_contract_id`, lock the contract.
- Verify button: `POST /api/deals/{id}/verify` when status is `submitted`.
  409 = wrong state or already running (body has the reason).
- Live progress: subscribe Realtime INSERTs on `verification_results` by
  `run_id`; render `evidence_storage_path` via signed URLs on the
  `verification-evidence` bucket.
- Verdict: `verification_runs.overall_verdict`; deal will be
  `awaiting_client_review`.

## Env & running locally

- `pip install -r agent/requirements.txt` to run the planner locally.
- Sandbox auth outside Vercel: `vercel link && vercel env pull`
  (VERCEL_OIDC_TOKEN) or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.
- Leave `VERIFY_CALLBACK_URL` empty on localhost — the orchestrator writes
  the transition straight to Supabase. Set it once deployed.
- Optional speed-up: `npx tsx scripts/create-sandbox-snapshot.ts` (needs
  `tsx`), put the printed id in `.env.local`.

## Open items

1. **No live sandbox dispatch has run yet** — code matches
   vercel.com/docs/sandbox/sdk-reference (2026-08: snapshot create/restore,
   mkDir-before-writeFiles, detached runCommand, default universal image with
   Python preinstalled), but do one real run before the demo.
2. **Production bundling**: `dispatch-verification.ts` reads `agent/*.py`
   from `process.cwd()` — fine under `next dev`; a Vercel deploy needs
   `outputFileTracingIncludes: { '/api/deals/[id]/verify': ['./agent/**'] }`
   in next.config.
3. **ADK**: `google-adk` is in requirements; the planner is currently a
   direct Groq JSON-mode call. If judging requires ADK, the natural home is
   the sub-agents (#3) as `LlmAgent`s — the `verify_items` contract doesn't
   care what's inside.
