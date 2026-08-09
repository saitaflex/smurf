// POST /api/deals/[id]/verify — kick off a sandboxed verification run.
// Idempotent under double-clicks: the submitted->verifying transition is a
// guarded UPDATE, so only one caller wins; losers get 409.
import { NextResponse } from 'next/server';
import { canStartVerification } from '@/lib/deal-state';
import { dispatchVerification } from '@/lib/sandbox/dispatch-verification';
import { createAdminClient } from '@/lib/supabase/admin';

// A run whose sandbox died silently (crash, timeout) never reports back; past
// this age we declare it dead so the deal can be retried instead of being
// stuck in 'verifying' forever. The 2-minute cron sweeper
// (/api/cron/sweep-stale-runs) does the same in the background; this inline
// check just makes the Verify button self-healing.
const STALE_RUN_MS =
  Number(process.env.SANDBOX_TIMEOUT_MS ?? 10 * 60 * 1000) + 60_000;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: dealId } = await params;
  const db = createAdminClient();

  const { data: deal, error } = await db
    .from('deals').select('*').eq('id', dealId).single();
  if (error || !deal) {
    return NextResponse.json({ error: 'deal not found' }, { status: 404 });
  }

  if (deal.project_status === 'verifying') {
    const { data: latest } = await db
      .from('verification_runs')
      .select('id, status, started_at')
      .eq('deal_id', dealId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const isStale = !latest ||
      (latest.status === 'running' &&
        Date.parse(latest.started_at) < Date.now() - STALE_RUN_MS);
    if (isStale) {
      if (latest) {
        await db.from('verification_runs')
          .update({
            status: 'timed_out',
            overall_verdict: 'error',
            summary: 'sandbox never reported back (stale-run recovery)',
            finished_at: new Date().toISOString(),
          })
          .eq('id', latest.id)
          .eq('status', 'running');
      }
      await db.from('deals').update({ project_status: 'submitted' })
        .eq('id', dealId).eq('project_status', 'verifying');
      deal.project_status = 'submitted'; // fall through and start a fresh run
    }
  }

  const guard = canStartVerification(deal);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.reason }, { status: 409 });
  }

  const { data: claimed } = await db
    .from('deals')
    .update({ project_status: 'verifying' })
    .eq('id', dealId)
    .eq('project_status', 'submitted')
    .select('id');
  if (!claimed?.length) {
    return NextResponse.json(
      { error: 'verification already in flight' }, { status: 409 });
  }

  const { data: run, error: runError } = await db
    .from('verification_runs')
    .insert({
      deal_id: dealId,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runError || !run) {
    await db.from('deals').update({ project_status: 'submitted' })
      .eq('id', dealId).eq('project_status', 'verifying');
    return NextResponse.json(
      { error: `failed to create run: ${runError?.message}` }, { status: 500 });
  }

  try {
    const { sandboxId } = await dispatchVerification({ runId: run.id, dealId });
    await db.from('verification_runs')
      .update({ sandbox_id: sandboxId }).eq('id', run.id);
    return NextResponse.json({ run_id: run.id, sandbox_id: sandboxId });
  } catch (err) {
    await db.from('verification_runs')
      .update({ status: 'failed', summary: `dispatch failed: ${String(err)}` })
      .eq('id', run.id);
    await db.from('deals').update({ project_status: 'submitted' })
      .eq('id', dealId).eq('project_status', 'verifying');
    return NextResponse.json(
      { error: 'failed to start sandbox' }, { status: 502 });
  }
}
