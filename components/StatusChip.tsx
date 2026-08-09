import { TONE_CLASSES, type Tone } from "@/lib/status";

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`ledger inline-flex items-center rounded-full px-2.5 py-1 ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  );
}
