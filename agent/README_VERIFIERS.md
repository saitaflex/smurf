# Verifier sub-agents

The three deliverable-type checkers, plus their tools. Owns everything between
"the orchestrator hands us a locked checklist" and "here are typed results with
evidence." Nothing here reads or writes Postgres, calls Gravv, or knows the deal
amount.

## Interface

```python
from agent.subagents import get_verifier
from agent.verification_types import ChecklistItem, DeliverableContext

results = get_verifier("backend_verifier")(items, ctx)
```

| | |
|---|---|
| **In** | `list[ChecklistItem]` (rows of `checklist_items`), `DeliverableContext(deliverable_url, evidence_dir, run_id)` |
| **Out** | `list[VerificationResult]` — one per item addressed to that verifier |
| **Raises** | nothing; an unrunnable check comes back as an `error` verdict |

`VerificationResult.to_row(run_id)` produces exactly the dict the orchestrator
inserts into `verification_results`. Evidence files are written to
`evidence_dir`; the orchestrator uploads them to the `verification-evidence`
bucket and rewrites `evidence_storage_path`.

`agent.subagents.run_all(items, ctx)` runs every verifier that has work, if the
orchestrator doesn't need per-group streaming.

## Verdict semantics

Four verdicts, and the distinction between them is load-bearing — the client
sees these on the approval screen and decides whether to release money.

| Verdict | Means | Example |
|---|---|---|
| `pass` | The check ran; the deliverable satisfied it. | `form#login` matched 1 element |
| `fail` | The check ran; the deliverable did not. **The freelancer's problem.** | selector matched 0 elements |
| `error` | The check could not be run. **Not the freelancer's fault.** | deliverable unreachable, malformed checklist item, `GROQ_API_KEY` unset |
| `needs_human_review` | The check ran but produced no trustworthy answer. | vision model answered "unclear", or below the confidence floor |

A deliverable that returns non-JSON to a JSON assertion is a `fail` — the
endpoint answered, it just answered wrongly. A deliverable we never reached is an
`error`. Collapsing those two would let a network blip read as a failed
deliverable, which on this platform is a step towards someone not being paid.

## Assertion catalogue — the Planner contract

The Planner emits `checklist_items.assertion`. `agent/assertions.py` is the
authoritative schema; **extra keys are rejected**, so anything not listed here
fails to parse and becomes an `error`.

### `frontend_verifier` — deliverable is an HTML page URL

| type | fields |
|---|---|
| `page_loads` | `max_load_ms` (default 10000), `expected_status` (default 200) |
| `element_exists` | `selector`, `min_count` (default 1) |
| `text_present` | `text`, `case_sensitive` (default false) |
| `element_text_matches` | `selector`, `expected_text`, `match`: `exact`\|`contains`\|`regex` (default contains), `case_sensitive` |
| `no_console_errors` | `allow_patterns`: list of regexes for known-acceptable noise |

### `backend_verifier` — deliverable is an API base URL

All share `path` (relative, default `/`), `method` (default GET), `request_body`, `headers`.

| type | extra fields |
|---|---|
| `http_status` | `expected_status` |
| `json_field_equals` | `field_path` (e.g. `users[0].roles[1]`), `expected` |
| `json_field_exists` | `field_path` |
| `json_shape` | `required_fields`: list of field paths |
| `response_time_under` | `max_ms` |
| `header_present` | `header`, `expected_value` (optional) |

`path` **must** be relative. An absolute URL in a checklist item is rejected, so
a checklist can never point a run at a host other than the registered
deliverable.

### `image_verifier` — deliverable is an image URL

| type | fields | how it's answered |
|---|---|---|
| `image_dimensions` | `min_width`, `min_height`, `exact_width`, `exact_height` | Pillow — deterministic |
| `image_format` | `allowed`: `png`\|`jpeg`\|`webp`\|`gif` | Pillow — deterministic |
| `vision_prompt` | `prompt`, `expect`: `yes`\|`no` (default yes) | Groq vision model |
| `vision_text_present` | `text` | Groq vision model |

Ask the model only for what a library cannot answer. "Is it 1920px wide" is a
header read, not a judgement call.

## Why two of the three verifiers contain no AI

`frontend_verifier` and `backend_verifier` are deterministic executors. A status
code, a selector count and a header value are facts: same input, same answer,
every run, and the freelancer can dispute a specific one with evidence. A model
asked "does this API look correct?" gives a fluent answer nobody can audit — and
this checklist is one client click away from releasing escrowed funds.

The vision model appears only where nothing deterministic exists ("is the logo on
a transparent background"), and even there it answers a closed question rather
than deciding anything.

## Security model

**SSRF (`agent/security/url_guard.py`).** `deliverable_url` is attacker-controlled
and we fetch it from inside a sandbox holding the Supabase service-role key and
the agent callback secret. Every URL is checked before connection: http/https
only, no embedded credentials, and every resolved address must be public —
loopback, RFC1918, unique-local, multicast and `169.254.0.0/16` (cloud instance
metadata) are refused. Redirects are followed manually so **each hop** is
re-validated, and the browser's route interceptor applies the same check to every
sub-resource a page requests, so `<img src="http://169.254.169.254/...">` is
aborted and recorded as evidence.

**Prompt injection.** Four independent layers, each tested in
`agent/tests/test_injection_resistance.py`:

1. Two of three verifiers have no model, so there is nothing to instruct.
2. The vision model's output alphabet is `yes` / `no` / `unclear`. "Approved" is
   not a value it can return; a reply outside the alphabet parses to `unclear`.
3. Which answer counts as passing is fixed in the locked checklist (`expect`), not
   chosen by the model — so even a fully compromised answer cannot flip an outcome.
4. Assertions are schema-validated with `extra="forbid"`, so a directive cannot
   ride inside a checklist item either.

Deliverable content is only ever a data field of a structured request. It is never
concatenated into a system prompt.

**Resource limits** (`agent/config.py`, all env-overridable): response bodies
capped at 8 MB streaming, images at 12 MB before decode and 50 M pixels after
(decompression bombs), 3 redirect hops, 15 s HTTP timeout, 20 s page load.

**We fetch images, the provider never does.** The image is downloaded through the
guarded client and sent to Groq inline as base64. Passing Groq the URL would make
it an SSRF proxy around our own guard.

## Running it

```bash
python -m venv .venv && .venv/bin/pip install -r agent/requirements.txt
.venv/bin/playwright install chromium

.venv/bin/python -m agent.run_subagent --demo    # all three vs built-in samples
.venv/bin/python -m pytest                       # 69 tests, no network or API key
```

Against a real deliverable:

```bash
python -m agent.run_subagent --sub-agent backend_verifier \
  --url https://api.example.com --checklist ./checklist.json --json
```

`--checklist` takes a JSON array of `checklist_items` rows — the same shape the
orchestrator reads from Postgres.

## Known limitations

- **DNS rebinding.** We validate the addresses a hostname resolves to, then httpx
  and Chromium resolve it again independently. A hostile resolver could answer
  differently the second time. Closing this needs connect-to-pinned-IP with a Host
  override; out of scope for the MVP, and the sandbox is a second boundary.
- **`GIGSFLOW_ALLOW_PRIVATE_HOSTS=1`** disables the SSRF guard. It exists so the
  test suite can reach fixtures on 127.0.0.1. It must never be set in the sandbox
  that runs real deliverables.
- **Single page load.** The frontend verifier navigates once; assertions needing
  interaction (click, then assert) are not expressible yet.
- **Vision cost/latency** scales linearly with the number of vision assertions —
  there is no batching of questions into one call.

## What the orchestrator needs to do

1. Read `checklist_items` for the deal's active contract, build `ChecklistItem`s
   via `ChecklistItem.from_row`.
2. Call `get_verifier(sub_agent)` per group (or `run_all`).
3. Insert `result.to_row(run_id)` per result, uploading `primary_evidence_path` to
   Storage first.
4. Aggregate `overall_verdict`. Suggested mapping, matching the
   `verification_runs.overall_verdict` constraint: any `error` or
   `needs_human_review` → `needs_human_review`; else any `fail` → `fail`; else
   `pass`. Aggregation is the orchestrator's call, not ours — we only report per
   item.
