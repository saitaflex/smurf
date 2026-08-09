// Planner boundary. The real Planner is agent/planner.py (Task-2 owner);
// until it's wired, contract/confirm uses the deterministic stub below so the
// frontend flow is demoable end-to-end. Swap `runPlanner` to call the real
// planner service — the return shape is the contract between the two.

import type { DeliverableType, StructuredRequirement, AmbiguityWarning, SubAgent } from "../supabase/types";
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

export async function runPlanner(
  requirementsRaw: string,
  deliverableType: DeliverableType,
  deliverableHintUrl?: string | null
): Promise<PlannerOutput> {
  // TODO(Task 2): replace with call to the real planner (agent/planner.py).
  return stubPlan(requirementsRaw, deliverableType, deliverableHintUrl);
}
