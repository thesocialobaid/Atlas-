import Link from "next/link";
import { CATEGORIES, CATEGORY_LABEL, categoryOf } from "@/lib/map/categories";
import type { Theme } from "@/lib/theme";
import type { ParseResult } from "@/parser/types";
import { Logo } from "../icons";
import { ThemeControl } from "../../theme-control";
import { Workspace } from "./workspace";

// The map's three columns: rail, canvas, detail pane. Fixed here; later phases
// fill them and never move them.
export function MapShell({ name, result, theme }: { name: string; result: ParseResult; theme: Theme }) {
  const counts = new Map<string, number>();
  for (const f of result.files) {
    const c = categoryOf(f);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  return (
    <div className="grid h-screen grid-cols-[192px_minmax(0,1fr)_320px] overflow-hidden text-[13px]">
      <aside className="flex min-h-0 flex-col border-r border-border bg-surface">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Link href="/" title="Dashboard" className="shrink-0">
            <Logo />
          </Link>
          <span className="truncate font-mono text-xs font-medium">{name}</span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto py-2">
          {CATEGORIES.filter((c) => counts.has(c)).map((c) => (
            <li key={c} className="flex h-7 items-center gap-2 px-3 text-xs">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: `var(--cat-${c})` }}
              />
              <span className="flex-1 truncate">{CATEGORY_LABEL[c]}</span>
              <span className="font-mono text-[11px] tabular-nums text-fg-muted">{counts.get(c)}</span>
            </li>
          ))}
        </ul>
        <div className="shrink-0 border-t border-border p-2">
          <ThemeControl initial={theme} />
        </div>
      </aside>

      {/* The map and the detail pane, the second and third columns. */}
      <Workspace name={name} result={result} />
    </div>
  );
}
