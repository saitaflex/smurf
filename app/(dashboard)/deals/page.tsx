import Link from "next/link";
import { createUserClient, getSessionProfile } from "@/lib/supabase/server";
import { StatusChip } from "@/components/StatusChip";
import { PROJECT_STATUS, PAYMENT_STATUS } from "@/lib/status";
import type { Deal } from "@/lib/supabase/types";

function money(amount: string | number, currency: string) {
  return `${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`;
}

export default async function DealsPage() {
  const profile = await getSessionProfile();
  const supabase = await createUserClient();

  // RLS already scopes this to deals the caller is a party to (or admin).
  const { data } = await supabase
    .from("deals")
    .select("*")
    .order("updated_at", { ascending: false });
  const deals = (data ?? []) as Deal[];

  const locked = deals.filter((d) => ["locked", "release_pending"].includes(d.payment_status));
  const awaitingReview = deals.filter((d) => d.project_status === "awaiting_client_review");
  const released = deals.filter((d) => d.payment_status === "released");
  const lockedTotal = locked.reduce((s, d) => s + Number(d.amount), 0);
  const releasedTotal = released.reduce((s, d) => s + Number(d.amount), 0);

  const isFreelancer = profile?.role === "freelancer";

  const cards = [
    { label: "Active deals", value: String(deals.filter((d) => !["approved", "declined", "cancelled"].includes(d.project_status)).length) },
    { label: isFreelancer ? "Protected for you" : "Money locked", value: money(lockedTotal, "USDC") },
    { label: "Awaiting review", value: String(awaitingReview.length) },
    { label: isFreelancer ? "Earned" : "Released", value: money(releasedTotal, "USDC") },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Deals</h1>
        {profile?.role === "client" && (
          <Link
            href="/deals/new"
            className="rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium hover:bg-cobalt-deep transition-colors"
          >
            New deal
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {cards.map((c) => (
          <div key={c.label} className="panel px-4 py-3">
            <p className="ledger text-ink-muted">{c.label}</p>
            <p className="font-mono text-lg mt-1">{c.value}</p>
          </div>
        ))}
      </div>

      {deals.length === 0 ? (
        <div className="panel px-6 py-16 text-center">
          <p className="font-medium mb-1">No deals yet</p>
          <p className="text-sm text-ink-muted mb-6">
            {profile?.role === "client"
              ? "Create a deal to turn a work agreement into a verifiable contract."
              : "Deals you're hired for will appear here."}
          </p>
          {profile?.role === "client" && (
            <Link
              href="/deals/new"
              className="rounded-lg bg-cobalt text-white px-4 py-2 text-sm font-medium hover:bg-cobalt-deep transition-colors"
            >
              Create your first deal
            </Link>
          )}
        </div>
      ) : (
        <div className="panel divide-y divide-line">
          {deals.map((d) => (
            <Link
              key={d.id}
              href={`/deals/${d.id}`}
              className="flex items-center gap-4 px-5 py-4 hover:bg-paper transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{d.title}</p>
                <p className="ledger text-ink-muted mt-1">
                  {d.deliverable_type} · {d.id.slice(0, 8)}
                </p>
              </div>
              <span className="font-mono text-sm shrink-0">{money(d.amount, d.currency)}</span>
              <div className="hidden sm:flex gap-2 shrink-0">
                <StatusChip {...PROJECT_STATUS[d.project_status]} />
                <StatusChip
                  label={PAYMENT_STATUS[d.payment_status].label}
                  tone={PAYMENT_STATUS[d.payment_status].tone}
                />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
