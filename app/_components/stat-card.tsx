import type { ReactNode } from "react";

export function StatCard({
  label,
  value,
  note,
  chart,
}: {
  label: string;
  value: number;
  note: ReactNode;
  chart?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-border bg-surface p-5">
      <p className="text-sm text-fg-muted">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="text-[32px] font-semibold leading-none tracking-tight tabular-nums">
          {value.toLocaleString("en-US")}
        </p>
        {chart}
      </div>
      <p className="mt-3 text-xs text-fg-muted">{note}</p>
    </div>
  );
}

/** A thin line over daily counts. No axes: the bar chart below has them. */
export function Sparkline({ values }: { values: number[] }) {
  const w = 96;
  const h = 32;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
