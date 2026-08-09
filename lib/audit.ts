import { supabaseAdmin } from "@/lib/supabase/server";

export async function auditEvent(
  dealId: string | null,
  actor: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdmin().from("audit_events").insert({
    deal_id: dealId,
    actor,
    event_type: eventType,
    payload,
  });
  if (error) console.error("audit_events insert failed:", error.message);
}
