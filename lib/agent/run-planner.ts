// Bridge for track #4's contract/confirm route: runs the planner as a local
// Python subprocess (stdin JSON -> stdout JSON). Fine for `next dev` and the
// demo; on a serverless deploy the planner would need to run in the sandbox
// instead (see TASK2_NOTES.md).
import { spawn } from 'child_process';

export interface PlanInput {
  requirements_prose: string;
  deliverable_type: 'frontend' | 'backend' | 'image';
}

export interface PlannedRequirement {
  id: string;
  description: string;
  acceptance_criteria: string[];
}

export interface PlannedChecklistItem {
  id: string;
  requirement_id: string;
  sub_agent: string;
  item_type: string;
  params: Record<string, unknown>;
  description: string;
  position: number;
}

export interface PlanResult {
  requirements: PlannedRequirement[];
  ambiguity_warnings: string[];
  checklist: PlannedChecklistItem[];
}

export function runPlanner(input: PlanInput): Promise<PlanResult> {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN ?? 'python';
    const proc = spawn(python, ['-m', 'agent.planner'], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`planner exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PlanResult);
      } catch {
        reject(new Error(`planner produced invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}
