// Planner boundary. The real Planner is agent/planner.py (Task 2): a Groq
// JSON-mode call with strict output validation, run as a local python
// subprocess (stdin JSON -> stdout JSON). If it can't run — no GROQ_API_KEY,
// no python, or it errors — we fall back to the deterministic stub so the
// frontend flow stays demoable end-to-end. The return shape here is the
// contract between the tracks.

import { spawn } from "child_process";
import type {
  AmbiguityWarning,
  DeliverableType,
  StructuredRequirement,
  SubAgent,
} from "../supabase/types";
import { stubPlan } from "./stub";

export interface PlannedChecklistItem {
  requirement_id: string;
  label: string;
  sub_agent: SubAgent;
  assertion: Record<string, unknown>;
  sort_order: number;
}

export interface PlannerOutput {
  requirements_structured: StructuredRequirement[];
  ambiguity_warnings: AmbiguityWarning[];
  checklist_items: PlannedChecklistItem[];
}

// Shape emitted by `python -m agent.planner` (see agent/schemas.py).
interface AgentPlanResult {
  requirements: { id: string; description: string; acceptance_criteria: string[] }[];
  ambiguity_warnings: string[];
  checklist: {
    requirement_id: string;
    sub_agent: SubAgent;
    item_type: string;
    params: Record<string, unknown>;
    label: string;
    sort_order: number;
  }[];
}

function runAgentPlanner(
  requirementsRaw: string,
  deliverableType: DeliverableType
): Promise<AgentPlanResult> {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN ?? "python";
    const proc = spawn(python, ["-m", "agent.planner"], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`planner exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as AgentPlanResult);
      } catch {
        reject(new Error(`planner produced invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    proc.stdin.write(
      JSON.stringify({
        requirements_prose: requirementsRaw,
        deliverable_type: deliverableType,
      })
    );
    proc.stdin.end();
  });
}

function toPlannerOutput(plan: AgentPlanResult): PlannerOutput {
  // The python planner uses uuid requirement ids; the UI expects "REQ-00N".
  const reqIdMap = new Map<string, string>();
  const requirements_structured: StructuredRequirement[] = plan.requirements.map((r, i) => {
    const id = `REQ-${String(i + 1).padStart(3, "0")}`;
    reqIdMap.set(r.id, id);
    return {
      id,
      description: r.description,
      acceptance_criteria: r.acceptance_criteria,
    };
  });
  return {
    requirements_structured,
    ambiguity_warnings: plan.ambiguity_warnings.map((message) => ({ message })),
    checklist_items: plan.checklist.map((item) => ({
      requirement_id: reqIdMap.get(item.requirement_id) ?? "",
      label: item.label,
      sub_agent: item.sub_agent,
      assertion: { type: item.item_type, ...item.params },
      sort_order: item.sort_order,
    })),
  };
}

export async function runPlanner(
  requirementsRaw: string,
  deliverableType: DeliverableType,
  deliverableHintUrl?: string | null
): Promise<PlannerOutput> {
  if (process.env.GROQ_API_KEY) {
    try {
      return toPlannerOutput(await runAgentPlanner(requirementsRaw, deliverableType));
    } catch (err) {
      console.warn(`real planner failed, falling back to stub: ${String(err)}`);
    }
  }
  return stubPlan(requirementsRaw, deliverableType, deliverableHintUrl);
}
