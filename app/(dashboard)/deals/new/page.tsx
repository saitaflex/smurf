"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DELIVERABLE_TYPES = [
  { value: "frontend", label: "Frontend", hint: "A deployed page — checked with a real browser." },
  { value: "backend", label: "Backend / API", hint: "A deployed API — checked with HTTP assertions." },
  { value: "image", label: "Image / design", hint: "An image — checked by a vision model, advisory only." },
] as const;

export default function NewDealPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    freelancer_email: "freelancer@demo.local",
    deliverable_type: "frontend",
    amount: "250",
    requirements_raw: "",
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, amount: Number(form.amount) }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error?.message ?? "Something went wrong.");
      setBusy(false);
      return;
    }
    router.push(`/deals/${json.deal.id}`);
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold mb-1">New deal</h1>
      <p className="text-sm text-ink-muted mb-8">
        Describe the work in plain language. The AI planner turns it into a
        contract with testable acceptance criteria — you review before anything locks.
      </p>

      <form onSubmit={submit} className="space-y-6">
        <label className="block">
          <span className="ledger text-ink-muted">Title</span>
          <input
            value={form.title}
            onChange={set("title")}
            required
            placeholder="Landing page for product launch"
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm focus:border-cobalt"
          />
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="ledger text-ink-muted">Freelancer email</span>
            <input
              value={form.freelancer_email}
              onChange={set("freelancer_email")}
              required
              type="email"
              className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm focus:border-cobalt"
            />
          </label>
          <label className="block">
            <span className="ledger text-ink-muted">Amount (USDC)</span>
            <input
              value={form.amount}
              onChange={set("amount")}
              required
              type="number"
              min="1"
              step="0.01"
              className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm font-mono focus:border-cobalt"
            />
          </label>
        </div>

        <fieldset>
          <legend className="ledger text-ink-muted mb-2">Deliverable type</legend>
          <div className="grid sm:grid-cols-3 gap-2">
            {DELIVERABLE_TYPES.map((t) => (
              <label
                key={t.value}
                className={`panel px-3 py-2.5 cursor-pointer transition-colors ${
                  form.deliverable_type === t.value ? "border-cobalt" : "hover:border-ink-muted"
                }`}
              >
                <input
                  type="radio"
                  name="deliverable_type"
                  value={t.value}
                  checked={form.deliverable_type === t.value}
                  onChange={set("deliverable_type")}
                  className="sr-only"
                />
                <span className="text-sm font-medium">{t.label}</span>
                <p className="text-xs text-ink-muted mt-0.5">{t.hint}</p>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="ledger text-ink-muted">Requirements</span>
          <textarea
            value={form.requirements_raw}
            onChange={set("requirements_raw")}
            required
            rows={8}
            placeholder={`One requirement per line, the more concrete the better:\nThe page shows the heading "Ship day one"\nThe /api/health endpoint returns 200\n...`}
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed focus:border-cobalt"
          />
          <p className="text-xs text-ink-muted mt-1.5">
            Vague lines (&quot;make it look modern&quot;) get flagged as ambiguous — they can&apos;t be tested.
          </p>
        </label>

        {error && <p className="text-sm text-crimson">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-cobalt text-white px-5 py-2.5 text-sm font-medium hover:bg-cobalt-deep transition-colors disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create draft deal"}
        </button>
      </form>
    </div>
  );
}
