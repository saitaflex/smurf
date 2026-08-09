// Next.js <-> Vercel Sandbox bridge for verification runs.
//
// Design: the snapshot (SANDBOX_SNAPSHOT_ID) only bakes *dependencies*
// (Python packages + Playwright Chromium); the agent/ source files are pushed
// fresh on every run. That keeps runs fast without ever executing stale code
// during the hackathon. With no snapshot configured it falls back to
// installing deps at run start (slow first verify, ~2 min — fine for dev).
//
// API verified against vercel.com/docs/sandbox/sdk-reference (2026-08):
// default image is vercel/sandbox/universal (Python 3.14 + Node preinstalled;
// the `runtime` option is deprecated), writeFiles does NOT create parent
// directories (hence the mkDir calls), and Sandbox.get({ name }) is how a
// sandbox is retrieved later — so we store `sandbox.name` as the identifier.
//
// Auth outside Vercel: either VERCEL_OIDC_TOKEN (via `vercel link` +
// `vercel env pull`) or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.

import { Sandbox } from '@vercel/sandbox';
import { spawn } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

const RUN_TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS ?? 10 * 60 * 1000);

export interface DispatchArgs {
  runId: string;
  dealId: string;
}

export interface DispatchResult {
  sandboxId: string; // the sandbox's `name`, usable with Sandbox.get({ name })
}

interface SandboxFile {
  path: string;
  content: Buffer;
}

// NOTE: in production on Vercel, agent/*.py must be traced into the function
// bundle (next.config: outputFileTracingIncludes) — see TASK2_NOTES.md.
async function collectAgentFiles(): Promise<{ dirs: string[]; files: SandboxFile[] }> {
  const root = path.join(process.cwd(), 'agent');
  const dirs: string[] = ['agent'];
  const files: SandboxFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(process.cwd(), abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__') {
          dirs.push(rel);
          await walk(abs);
        }
      } else {
        files.push({ path: rel, content: await readFile(abs) });
      }
    }
  }
  await walk(root);
  return { dirs, files };
}

function runEnv(args: DispatchArgs): Record<string, string> {
  return {
    RUN_ID: args.runId,
    DEAL_ID: args.dealId,
    AGENT_CALLBACK_SECRET: process.env.AGENT_CALLBACK_SECRET ?? '',
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
    VERIFY_CALLBACK_URL: process.env.VERIFY_CALLBACK_URL ?? '',
  };
}

export async function dispatchVerification(args: DispatchArgs): Promise<DispatchResult> {
  // Dev mode (SANDBOX_LOCAL=1): run the orchestrator as a local python
  // process instead of a Vercel sandbox, so the whole verification loop works
  // on one laptop with no Vercel credentials. Requires
  // `pip install -r agent/requirements.txt` locally.
  if (process.env.SANDBOX_LOCAL === '1') {
    const python = process.env.PYTHON_BIN ?? 'python';
    const proc = spawn(python, ['-m', 'agent.orchestrator'], {
      cwd: process.cwd(),
      env: { ...process.env, ...runEnv(args) },
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    return { sandboxId: `local-${proc.pid}` };
  }

  const snapshotId = process.env.AGENT_BROWSER_SNAPSHOT_ID;

  // Default image (vercel/sandbox/universal) already ships Python; one-shot
  // runs don't need auto-persistence snapshots on stop.
  const sandbox = snapshotId
    ? await Sandbox.create({
        source: { type: 'snapshot', snapshotId },
        timeout: RUN_TIMEOUT_MS,
        persistent: false,
      })
    : await Sandbox.create({
        timeout: RUN_TIMEOUT_MS,
        persistent: false,
      });

  try {
    const { dirs, files } = await collectAgentFiles();
    for (const dir of dirs) {
      await sandbox.mkDir(dir); // writeFiles does not create parent dirs
    }
    await sandbox.writeFiles(files);

    const setup = snapshotId
      ? ''
      : 'pip install -q -r agent/requirements.txt && python -m playwright install --with-deps chromium && ';

    // Detached: verification (Playwright runs) can take 30s-2min, well past a
    // route handler's comfort zone. Completion arrives via the agent-callback
    // route (or the orchestrator's direct-to-Supabase fallback).
    await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `${setup}python -m agent.orchestrator`],
      detached: true,
      env: runEnv(args),
    });

    return { sandboxId: sandbox.name };
  } catch (err) {
    await sandbox.stop().catch(() => {});
    throw err;
  }
}
