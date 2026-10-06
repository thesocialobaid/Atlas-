"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CATEGORIES, CATEGORY_LABEL, categoryOf, type Category } from "@/lib/map/categories";
import { describeFile, describeFolder, summarise } from "@/lib/map/detail";
import { fold } from "@/lib/map/fold";
import { insights as findInsights, reach as walk, type Direction } from "@/lib/map/graph";
import { fileEdges } from "@/lib/map/view";
import type { Theme } from "@/lib/theme";
import type { MapInput } from "@/lib/map/input";
import { Logo } from "../icons";
import { ThemeControl } from "../../theme-control";
import { MapCanvas, type Base } from "./canvas";
import { CoverageBanner } from "./coverage-banner";
import { DetailPane, type Tab } from "./pane";
import { HoverContext, type Hover, type Selection } from "./state";

// The map and the detail pane share one selection, one set of open folders
// and one hover, so they live here rather than in either. Everything the pane
// shows is derived from the result already in the browser: selecting fires no
// request.
export function Workspace({
  name,
  result,
  theme,
}: {
  name: string;
  result: MapInput;
  theme: Theme;
}) {
  // Derived from the parser's output, never written back into it.
  const base = useMemo<Base>(
    () => ({
      folded: fold(result.files),
      edges: fileEdges(result.edges),
      fanIn: new Map(result.fan.map((f) => [f.path, f.fanIn])),
      categories: new Map(result.files.map((f) => [f.path, categoryOf(f)])),
    }),
    [result],
  );
  const files = useMemo(() => new Map(result.files.map((f) => [f.path, f])), [result]);
  const summary = useMemo(() => summarise(result), [result]);
  const insights = useMemo(() => findInsights(result.files, base.edges), [result, base]);
  const railCounts = useMemo(() => {
    const counts = new Map<Category, number>();
    for (const c of base.categories.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    return counts;
  }, [base]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Hover>(null);
  // Kept across selections: comparing three explanations shouldn't mean
  // reopening the tab three times.
  const [tab, setTab] = useState<Tab>("structure");
  // Kept across selections for the same reason: comparing blast radii.
  const [direction, setDirection] = useState<Direction | null>(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);

  // Every handler that swaps what's under the pointer clears the hover, since
  // the element that would have sent mouseleave is gone.
  const clear = useCallback(() => {
    setSelection(null);
    setHover(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clear]);

  const openFolder = useCallback((dir: string) => {
    setOpen((prev) => new Set(prev).add(dir));
    setSelection({ kind: "group", dir });
    setHover(null);
  }, []);

  const closeFolder = useCallback(
    (dir: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
      setSelection((s) =>
        s && (s.kind === "group" ? s.dir === dir : base.folded.groupOf.get(s.path) === dir) ? null : s,
      );
      setHover(null);
    },
    [base],
  );

  const toggleFile = useCallback(
    (path: string) => setSelection((s) => (s?.kind === "file" && s.path === path ? null : { kind: "file", path })),
    [],
  );

  // From the pane: select the file and open the box it's drawn in, so the
  // selection is a row you can see rather than a lit-up closed folder.
  const goToFile = useCallback(
    (path: string) => {
      const dir = base.folded.groupOf.get(path);
      if (dir !== undefined) setOpen((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
      setSelection({ kind: "file", path });
      setHover(null);
    },
    [base],
  );

  const file = useMemo(
    () => (selection?.kind === "file" ? describeFile(result, files, base.edges, selection.path) : null),
    [selection, result, files, base],
  );
  const folder = useMemo(
    () => (selection?.kind === "group" ? describeFolder(base.folded, files, selection.dir) : null),
    [selection, base, files],
  );

  const reached = useMemo(
    () => (selection?.kind === "file" && direction ? walk(base.edges, selection.path, direction) : null),
    [selection, direction, base],
  );

  const hoverApi = useMemo(() => ({ hover, setHover }), [hover]);

  return (
    <HoverContext.Provider value={hoverApi}>
      <aside className="flex min-h-0 flex-col border-r border-border bg-surface">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Link href="/" title="Dashboard" className="shrink-0">
            <Logo />
          </Link>
          <span className="truncate font-mono text-xs font-medium">{name}</span>
        </div>
        {/* Clicking a kind dims the rest of the map rather than removing it, so
            the shape of the repository stays on screen. */}
        <ul aria-label="Kinds of file" className="min-h-0 flex-1 overflow-y-auto py-2">
          {CATEGORIES.filter((c) => railCounts.has(c)).map((c) => (
            <li key={c}>
              <button
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory((cur) => (cur === c ? null : c))}
                className={`flex h-7 w-full items-center gap-2 px-3 text-left text-xs ${
                  category === c
                    ? "bg-surface-2 font-medium"
                    : category !== null
                      ? "text-fg-muted hover:bg-surface-2 hover:text-fg"
                      : "hover:bg-surface-2"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: `var(--cat-${c})` }}
                />
                <span className="flex-1 truncate">{CATEGORY_LABEL[c]}</span>
                <span className="font-mono text-[11px] tabular-nums text-fg-muted">{railCounts.get(c)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="shrink-0 border-t border-border p-2">
          <ThemeControl initial={theme} />
        </div>
      </aside>

      <main className="flex min-h-0 flex-col bg-bg">
        <CoverageBanner coverage={result.coverage} />
        <div className="relative min-h-0 flex-1">
          <MapCanvas
            base={base}
            open={open}
            category={category}
            selection={selection}
            onOpen={openFolder}
            onClose={closeFolder}
            onSelectFile={toggleFile}
            onClear={clear}
          />
        </div>
      </main>

      <aside aria-label="Details" className="min-h-0 border-l border-border bg-surface">
        <DetailPane
          name={name}
          summary={summary}
          insights={insights}
          insightsOpen={insightsOpen}
          onInsightsOpen={setInsightsOpen}
          categories={base.categories}
          file={file}
          folder={folder}
          tab={tab}
          onTab={setTab}
          reach={{ direction, found: reached }}
          onReach={setDirection}
          onGo={goToFile}
          onClear={clear}
        />
      </aside>
    </HoverContext.Provider>
  );
}
