// One-off: bake a sandbox snapshot with Python deps + Playwright Chromium
// preinstalled, so verification runs skip ~2 min of cold-start install.
//
// Usage:  npx tsx scripts/create-sandbox-snapshot.ts
// Then put the printed id in .env.local as AGENT_BROWSER_SNAPSHOT_ID.
// Re-run only when agent/requirements.txt changes — agent source code is
// pushed fresh on every run and does not require a re-bake.
//
// Auth: VERCEL_OIDC_TOKEN (via `vercel env pull`) or VERCEL_TOKEN +
// VERCEL_TEAM_ID + VERCEL_PROJECT_ID. API verified against
// vercel.com/docs/sandbox/sdk-reference (2026-08). Note: snapshots expire
// 30 days after last use by default.

import { Sandbox } from '@vercel/sandbox';
import { readFile } from 'fs/promises';
import path from 'path';

async function main() {
  console.log('creating sandbox (default universal image, Python included)...');
  const sandbox = await Sandbox.create({
    timeout: 20 * 60 * 1000,
    persistent: false,
  });

  try {
    await sandbox.mkDir('agent'); // writeFiles does not create parent dirs
    await sandbox.writeFiles([{
      path: 'agent/requirements.txt',
      content: await readFile(path.join(process.cwd(), 'agent', 'requirements.txt')),
    }]);

    for (const cmd of [
      'pip install -r agent/requirements.txt',
      'python -m playwright install --with-deps chromium',
    ]) {
      console.log(`running: ${cmd}`);
      const result = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', cmd] });
      if (result.exitCode !== 0) {
        console.error(await result.stderr());
        throw new Error(`'${cmd}' exited ${result.exitCode}`);
      }
    }

    console.log('snapshotting (this also shuts the sandbox down)...');
    const snapshot = await sandbox.snapshot();
    console.log('\nAGENT_BROWSER_SNAPSHOT_ID=' + snapshot.snapshotId);
  } catch (err) {
    // snapshot() auto-stops the sandbox; stop() here only matters on the
    // error path and is documented as safe to call multiple times.
    await sandbox.stop().catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
