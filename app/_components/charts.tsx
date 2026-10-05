import { formatSeconds } from "@/lib/dashboard-math";

const AXIS = "var(--fg-muted)";
const GRID = "var(--border)";

function niceMax(value: number) {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / pow) * pow;
}

/** Analyses started per day. Horizontal guides only, labelled sparsely. */
export function DailyBars({ days }: { days: { day: string; count: number }[] }) {
  const w = 480;
  const h = 180;
  const pad = { top: 8, right: 4, bottom: 22, left: 24 };
  const max = niceMax(Math.max(...days.map((d) => d.count)));
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;
  const slot = innerW / days.length;
  const bar = Math.min(18, slot * 0.55);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Analyses started per day: ${days.map((d) => `${d.day} ${d.count}`).join(", ")}`}
    >
      {[0, max / 2, max].map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
          <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill={AXIS} className="tabular-nums">
            {t}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = pad.left + i * slot + (slot - bar) / 2;
        const top = y(d.count);
        return (
          <g key={d.day}>
            <title>{`${d.day}: ${d.count}`}</title>
            {d.count > 0 && (
              <rect x={x} y={top} width={bar} height={pad.top + innerH - top} rx="3" fill="var(--accent)" />
            )}
            {(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && (
              <text x={x + bar / 2} y={h - 6} textAnchor="middle" fontSize="10" fill={AXIS}>
                {d.day.slice(5).replace("-", "/")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** One horizontal bar per finished analysis, longest scale wins. */
export function DurationBars({
  rows,
}: {
  rows: { label: string; seconds: number; failed: boolean }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.seconds));
  return (
    <ul className="space-y-3">
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`} className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem] items-center gap-3 text-xs">
          <span className="truncate font-mono text-fg">{r.label}</span>
          <span className="h-1.5 rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.max(2, (r.seconds / max) * 100)}%`,
                background: r.failed ? "var(--danger)" : "var(--accent)",
              }}
            />
          </span>
          <span className="text-right tabular-nums text-fg-muted">{formatSeconds(r.seconds)}</span>
        </li>
      ))}
    </ul>
  );
}
