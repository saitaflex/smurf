// GET /api/cron/sweep-stale-runs — scheduled every 2 minutes (vercel.json).
// Marks verification runs whose sandbox died silently as timed_out and
// returns their deals from 'verifying' to 'submitted' so they can be retried.
// Vercel sends `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set.
import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const STALE_RUN_MS =
  Number(process.env.SANDBOX_TIMEOUT_MS ?? 10 * 60 * 1000) + 60_000;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!expected || !secretMatches(provided, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_RUN_MS).toISOString();

  const { data: staleRuns } = await db
    .from('verification_runs')
    .select('id, deal_id')
    .eq('status', 'running')
    .lt('started_at', cutoff);

  let swept = 0;
  for (const run of staleRuns ?? []) {
    const { data: claimed } = await db
      .from('verification_runs')
      .update({
        status: 'timed_out',
        overall_verdict: 'error',
        summary: 'sandbox never reported back (cron sweep)',
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .eq('status', 'running')
      .select('id');
    if (!claimed?.length) continue; // finished between select and update

    await db.from('deals')
      .update({ project_status: 'submitted' })
      .eq('id', run.deal_id)
      .eq('project_status', 'verifying');

    const { error: auditError } = await db.from('audit_events').insert({
      deal_id: run.deal_id,
      actor: 'system',
      event_type: 'verification_timed_out',
      payload: { run_id: run.id },
    });
    if (auditError) console.warn('audit_events insert failed:', auditError.message);
    swept += 1;
  }

  return NextResponse.json({ ok: true, swept });
}
