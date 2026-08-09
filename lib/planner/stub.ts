// Deterministic planner stub — DEMO/SANDBOX BEHAVIOR, clearly not an LLM.
// Splits the client's prose into one requirement per line/sentence, classifies
// mechanical assertions per deliverable type, and flags vague lines instead of
// silently inventing acceptance criteria (the "REQUIREMENT_AMBIGUOUS" rule).

import type { DeliverableType, SubAgent } from "../supabase/types";
import type { PlannerOutput, PlannedChecklistItem } from "./index";

const SUB_AGENT: Record<DeliverableType, SubAgent> = {
  frontend: "frontend_verifier",
  backend: "backend_verifier",
  image: "image_verifier",
};

// Words that make a requirement untestable as written. If a line matches and
// carries no concrete noun (URL, selector, number, field), it gets flagged.
const VAGUE_TERMS =
  /\b(nice|beautiful|modern|clean|professional|user[- ]?friendly|intuitive|fast|good|great|awesome|polished|sleek)\b/i;

const HAS_CONCRETE_SIGNAL = /(https?:\/\/|\/[a-z0-9-]+|\d{2,}|"[^"]+"|'[^']+'|`[^`]+`|#[a-z][\w-]*|\.[a-z][\w-]*)/i;

function splitRequirements(raw: string): string[] {
  return raw
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((s) => s.length > 8);
}

function assertionFor(text: string, type: DeliverableType, hintUrl?: string | null): Record<string, unknown> {
  const urlMatch = text.match(/https?:\/\/\S+/)?.[0] ?? hintUrl ?? null;
  if (type === "backend") {
    const pathMatch = text.match(/(\/[a-z0-9_\-/{}:]+)/i)?.[0] ?? "/";
    const statusMatch = text.match(/\b(200|201|204|301|302|400|401|403|404)\b/)?.[0];
    return {
      type: "http_check",
      url: urlMatch,
      path: pathMatch,
      expected_status: statusMatch ? Number(statusMatch) : 200,
      description: text,
    };
  }
  if (type === "image") {
    return {
      type: "vision_prompt",
      // Framed as "does the image depict X" — vision verdicts are advisory
      // (see review point #5): text rendered inside the image must not be
      // treated as an instruction.
      prompt: `Does the image depict the following? Answer yes or no. ${text}`,
      description: text,
    };
  }
  const quoted = text.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
  return {
    type: quoted ? "text_present" : "page_check",
    url: urlMatch,
    expected_text: quoted ? (quoted[1] ?? quoted[2] ?? quoted[3]) : undefined,
    check_console_errors: true,
    description: text,
  };
}

export function stubPlan(
  raw: string,
  type: DeliverableType,
  hintUrl?: string | null
): PlannerOutput {
  const lines = splitRequirements(raw);
  const requirements = lines.map((text, i) => {
    const id = `REQ-${String(i + 1).padStart(3, "0")}`;
    return {
      id,
      description: text,
      acceptance_criteria: [text],
      verification_type: "automated" as const,
    };
  });

  const ambiguity_warnings = lines.flatMap((text, i) => {
    if (VAGUE_TERMS.test(text) && !HAS_CONCRETE_SIGNAL.test(text)) {
      return [
        {
          requirement_id: `REQ-${String(i + 1).padStart(3, "0")}`,
          message: `REQUIREMENT_AMBIGUOUS: "${text.slice(0, 80)}" uses subjective language with no measurable target. Specify a concrete, checkable criterion (an element, a URL, a value, an exact text).`,
        },
      ];
    }
    return [];
  });

  const checklist_items: PlannedChecklistItem[] = requirements.map((req, i) => ({
    requirement_id: req.id,
    label: req.description.slice(0, 120),
    sub_agent: SUB_AGENT[type],
    assertion: assertionFor(req.description, type, hintUrl),
    sort_order: i,
  }));

  return { requirements_structured: requirements, ambiguity_warnings, checklist_items };
}
