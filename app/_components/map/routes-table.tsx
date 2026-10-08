"use client";

import { useMemo } from "react";
import { frameworkName } from "@/parser/adapters/taxonomy";
import { HTTP_METHODS, type Route, type Withheld } from "@/parser/types";

const named = (framework: string) => frameworkName(framework) ?? framework;

// Every route an adapter read exactly, and beneath it what it saw but wouldn't
// guess at. Clicking a row selects its file, so the pane explains it while the
// table stays put.
export function RoutesTable({
  routes,
  withheld,
  frameworks,
  selected,
  onGo,
}: {
  routes: readonly Route[];
  /** Null when the analysis was stored before routes were read. */
  withheld: readonly Withheld[] | null;
  /** Display names; empty when no framework was recognised. */
  frameworks: readonly string[];
  selected: string | null;
  onGo: (path: string) => void;
}) {
  const sorted = useMemo(
    () =>
      [...routes].sort(
        (a, b) =>
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
          HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method) ||
          (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
          (a.framework < b.framework ? -1 : 1),
      ),
    [routes],
  );

  const empty =
    frameworks.length === 0
      ? "No framework was recognised, so no routes are read."
      : withheld === null
        ? "This analysis was stored before routes were read. Run it again to read them."
        : `No routes could be read exactly from this ${frameworks.join(" and ")} code.`;

  return (
    <div className="h-full overflow-y-auto">
      {sorted.length === 0 ? (
        <p className="px-3 py-3 text-xs text-fg-muted">{empty}</p>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <thead className="sticky top-0 bg-surface text-left text-[11px] text-fg-muted">
            <tr className="h-7 border-b border-border">
              <th className="w-20 px-3 font-normal">Method</th>
              <th className="px-3 font-normal">Pattern</th>
              <th className="px-3 font-normal">Declared in</th>
              <th className="w-28 px-3 font-normal">Framework</th>
            </tr>
          </thead>
          <tbody className="font-mono text-[11px]">
            {sorted.map((r) => (
              <tr
                key={`${r.framework} ${r.file} ${r.method} ${r.path}`}
                onClick={() => onGo(r.file)}
                aria-selected={r.file === selected}
                className={`h-[22px] cursor-pointer border-b border-border hover:bg-surface-2 ${
                  r.file === selected ? "bg-surface-2" : ""
                }`}
              >
                <td className="px-3">{r.method}</td>
                <td className="truncate px-3" title={r.path}>
                  {r.path}
                </td>
                <td className="truncate px-3 text-fg-muted" title={`${r.file}:${r.line}`}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onGo(r.file);
                    }}
                    className="hover:text-fg"
                  >
                    {r.file}:{r.line}
                  </button>
                </td>
                <td className="truncate px-3 font-sans text-fg-muted">{named(r.framework)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {withheld !== null && withheld.length > 0 && (
        <section className="border-t border-border px-3 py-3">
          <h3 className="text-xs font-medium">
            Not listed{" "}
            <span className="font-mono text-[11px] font-normal tabular-nums text-fg-muted">
              {withheld.reduce((n, g) => n + g.count, 0)}
            </span>
          </h3>
          <p className="pb-2 text-[11px] leading-4 text-fg-muted">
            Seen in the code, but the method or the full pattern couldn&apos;t be read without guessing.
          </p>
          <ul className="space-y-2">
            {withheld.map((g) => (
              <li key={`${g.framework} ${g.reason}`} className="text-xs">
                <div className="flex gap-2">
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums">{g.count}</span>
                  <span>
                    <span className="text-fg-muted">{named(g.framework)}: </span>
                    {g.reason}
                  </span>
                </div>
                <ul className="pl-10 font-mono text-[11px] text-fg-muted">
                  {g.examples.map((e) => (
                    <li key={e} className="truncate" title={e}>
                      {e}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
