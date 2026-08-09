// POST /api/agent-callback/verification-complete — the sandbox orchestrator
// reports its verdict here, authenticated with the shared AGENT_CALLBACK_SECRET
// (Authorization: Bearer <secret>).
//
// The orchestrator has already written overall_verdict to verification_runs;
// this route's job is the deal state transition. The orchestrator writes the
// run row BEFORE calling us, so run.status is usually already
// 'completed'/'failed' here — never gate on it. Idempotency comes from the
// guarded deal update: only the first delivery matches a deal still in
// 'verifying'; retries match zero rows and are no-ops.
import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// verification_runs.overall_verdict check constraint (0001_init.sql)
const TERMINAL_VERDICTS = ['pass', 'fail', 'pass_with_warnings', 'needs_human_review', 'error'];

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  let body: { run_id?: string; overall_verdict?: string; summary?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { run_id: runId, overall_verdict: verdict, summary } = body;
  if (!runId || !verdict || !TERMINAL_VERDICTS.includes(verdict)) {
    return NextResponse.json({ error: 'run_id and a valid overall_verdict are required' }, { status: 400 });
  }

  const expected = process.env.AGENT_CALLBACK_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!expected || !provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const { data: run } = await db
    .from('verification_runs')
    .select('id, deal_id, status')
    .eq('id', runId)
    .single();
  if (!run) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 });
  }

  await db.from('verification_runs').update({
    status: verdict === 'error' ? 'failed' : 'completed',
    overall_verdict: verdict,
    summary: summary ?? '',
    finished_at: new Date().toISOString(),
  }).eq('id', runId);

  // error -> back to submitted (retryable); anything else -> client review.
  const nextStatus = verdict === 'error' ? 'submitted' : 'awaiting_client_review';
  const { data: transitioned } = await db.from('deals')
    .update({ project_status: nextStatus })
    .eq('id', run.deal_id)
    .eq('project_status', 'verifying')
    .select('id');

  if (transitioned?.length) {
    // Best-effort audit trail; never fail the callback over it.
    const { error: auditError } = await db.from('audit_events').insert({
      deal_id: run.deal_id,
      actor: 'agent',
      event_type: 'verification_completed',
      payload: { run_id: runId, overall_verdict: verdict, summary },
    });
    if (auditError) console.warn('audit_events insert failed:', auditError.message);
  }

  return NextResponse.json({ ok: true, transitioned: !!transitioned?.length });
}
