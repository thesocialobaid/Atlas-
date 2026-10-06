"use client";

import { useState } from "react";
import type { Coverage } from "@/parser/types";

/** How many of the reasons an import didn't resolve are listed when open. */
const SHOWN_REASONS = 4;

/**
 * The share of imports pointing into this repository that were tied to a
 * file. Externals aren't counted either way: they were never going to be
 * files here. Rounded down, so a partial graph can never read as 100%.
 */
export function resolvedShare(coverage: Coverage): { resolved: number; total: number; percent: number } | null {
  const { resolved, unresolved } = coverage.imports;
  const total = resolved + unresolved;
  if (unresolved === 0 || total === 0) return null;
  return { resolved, total, percent: Math.floor((resolved / total) * 100) };
}

// Says the graph is partial when it is. It may be collapsed, but only to one
// line that still names the figure: a map that is quietly 70% complete must
// never look complete.
export function CoverageBanner({ coverage }: { coverage: Coverage }) {
  const [open, setOpen] = useState(true);
  const share = resolvedShare(coverage);
  if (!share) return null;
  const missing = share.total - share.resolved;
  const reasons = coverage.reasons.filter((r) => r.outcome === "unresolved").sort((a, b) => b.count - a.count);

  return (
    <section aria-label="Coverage" className="shrink-0 border-b border-border bg-surface px-3 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate">
          <span className="font-medium">Partial graph: {share.percent}%</span>{" "}
          <span className="text-fg-muted">
            of imports into this repository were tied to a file ({share.resolved.toLocaleString("en-US")} of{" "}
            {share.total.toLocaleString("en-US")}). {missing.toLocaleString("en-US")} couldn&apos;t be and aren&apos;t drawn.
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 text-fg-muted hover:text-fg"
        >
          {open ? "Hide reasons" : "Show reasons"}
        </button>
      </div>
      {open && (
        <ul className="mt-1 space-y-0.5 pb-0.5">
          {reasons.slice(0, SHOWN_REASONS).map((r) => (
            <li key={r.reason} className="flex gap-2 text-fg-muted">
              <span className="w-10 shrink-0 text-right font-mono tabular-nums">{r.count}</span>
              <span className="min-w-0">
                {r.reason}
                {r.examples[0] && (
                  <span className="font-mono">
                    {" "}
                    e.g. {r.examples[0].from}:{r.examples[0].line} {r.examples[0].specifier}
                  </span>
                )}
              </span>
            </li>
          ))}
          {reasons.length > SHOWN_REASONS && (
            <li className="pl-12 text-fg-muted">and {reasons.length - SHOWN_REASONS} more reasons</li>
          )}
        </ul>
      )}
    </section>
  );
}
