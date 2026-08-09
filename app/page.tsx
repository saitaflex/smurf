import Link from "next/link";
import { BRAND } from "@/lib/brand";

const STEPS = [
  { k: "AGREE", d: "Requirements become a structured contract with acceptance criteria — ambiguity is flagged before anyone commits." },
  { k: "LOCK", d: "The client's deposit sits in a dedicated escrow account. The freelancer can see it; nobody can move it." },
  { k: "VERIFY", d: "AI sub-agents execute the exact tests locked at contract time and attach evidence to every requirement." },
  { k: "RELEASE", d: "The client reviews the evidence and approves. Only then does escrow release. AI never touches the money." },
];

export default function Landing() {
  return (
    <main className="flex-1">
      <header className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto w-full">
        <span className="ledger text-ink">{BRAND}</span>
        <Link
          href="/login"
          className="ledger rounded-full border border-line px-4 py-2 hover:border-ink transition-colors"
        >
          Sign in
        </Link>
      </header>

      <section className="max-w-5xl mx-auto px-6 pt-20 pb-16">
        <p className="ledger text-ink-muted mb-6">AI-verified escrow for freelance work</p>
        <h1 className="[font-family:var(--font-instrument-serif)] text-5xl sm:text-7xl leading-[1.05] max-w-3xl">
          Freelance work shouldn&apos;t be a <em className="text-cobalt">leap of faith.</em>
        </h1>
        <p className="mt-8 max-w-xl text-lg text-ink-muted leading-relaxed">
          Agree on the work. Lock the payment. Let AI verify the deliverable
          against the contract — with evidence, not vibes. Release with
          confidence.
        </p>
        <div className="mt-10 flex gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-cobalt text-white px-5 py-3 text-sm font-medium hover:bg-cobalt-deep transition-colors"
          >
            Open a deal
          </Link>
          <a
            href="#how"
            className="rounded-lg border border-line px-5 py-3 text-sm font-medium hover:border-ink transition-colors"
          >
            How it works
          </a>
        </div>
      </section>

      {/* Receipt-style process strip: the product in four ledger lines. */}
      <section id="how" className="max-w-5xl mx-auto px-6 pb-24 w-full">
        <div className="panel divide-y divide-line">
          {STEPS.map((s, i) => (
            <div key={s.k} className="flex items-baseline gap-4 px-6 py-5">
              <span className="ledger text-ink-muted w-8 shrink-0">{String(i + 1).padStart(2, "0")}</span>
              <span className="ledger text-ink w-24 shrink-0">{s.k}</span>
              <span className="leader hidden sm:block" />
              <p className="text-sm text-ink-muted max-w-lg">{s.d}</p>
            </div>
          ))}
        </div>
        <p className="ledger text-ink-muted mt-6 text-center">
          What was promised → tested → delivered → proven → paid
        </p>
      </section>
    </main>
  );
}
