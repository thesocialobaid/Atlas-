"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { explainFileAction, explainFolderAction, freshnessAction, reanalyseAction } from "@/app/map/[id]/actions";
import { categoryOf } from "@/lib/map/categories";
import { describeFile, describeFolder, summarise } from "@/lib/map/detail";
import { fold } from "@/lib/map/fold";
import { insights as findInsights, reach as walk, type Direction } from "@/lib/map/graph";
import { buildRail, type RailEntry } from "@/lib/map/rail";
import { fileEdges } from "@/lib/map/view";
import type { Theme } from "@/lib/theme";
import type { MapInput } from "@/lib/map/input";
import { Logo } from "../icons";
import { ThemeControl } from "../../theme-control";
import { AskPane, AskToggle, useConversation } from "./ask-pane";
import { MapCanvas, type Base } from "./canvas";
import { CoverageBanner } from "./coverage-banner";
import { DetailPane, type Asked, type Tab } from "./pane";
import { RoutesTable } from "./routes-table";
import { HoverContext, type Hover, type Selection } from "./state";

// The map and the detail pane share one selection, one set of open folders
// and one hover, so they live here rather than in either. Everything the pane
// shows is derived from the result already in the browser: selecting fires no
// request.
export function Workspace({
  analysisId,
  name,
  result,
  theme,
}: {
  analysisId: string;
  name: string;
  result: MapInput;
  theme: Theme;
}) {
  // Derived from the parser's output, never written back into it.
  const rail = useMemo(() => buildRail(result.adapters, result.files), [result]);
  const base = useMemo<Base>(
    () => ({
      folded: fold(result.files),
      edges: fileEdges(result.edges),
      fanIn: new Map(result.fan.map((f) => [f.path, f.fanIn])),
      categories: new Map(result.files.map((f) => [f.path, categoryOf(f)])),
      entryOf: rail.entryOf,
    }),
    [result, rail],
  );
  const files = useMemo(() => new Map(result.files.map((f) => [f.path, f])), [result]);
  const summary = useMemo(() => summarise(result), [result]);
  const insights = useMemo(() => findInsights(result.files, base.edges), [result, base]);

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Hover>(null);
  // Kept across selections: comparing three explanations shouldn't mean
  // reopening the tab three times.
  const [tab, setTab] = useState<Tab>("structure");
  // Kept across selections for the same reason: comparing blast radii.
  const [direction, setDirection] = useState<Direction | null>(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [filter, setFilter] = useState<RailEntry | null>(null);
  const [showRoutes, setShowRoutes] = useState(false);
  // Every explanation asked for, by what it explains. Kept here rather than
  // in the pane, so moving the selection away and back shows it again
  // without a second click: a cache nobody can feel is not a cache.
  const [answers, setAnswers] = useState<ReadonlyMap<string, Asked>>(new Map());
  // Ask replaces the pane without touching the selection, so stepping out of
  // it lands on whatever was selected, and the conversation waits here.
  const [askOpen, setAskOpen] = useState(false);
  const conversation = useConversation(analysisId);
  const [reanalysing, startReanalyse] = useTransition();
  const [reanalyseError, setReanalyseError] = useState<string | null>(null);

  // What the prose may link to: every file, and every folder drawn as a box.
  const known = useMemo(
    () => ({ files: new Set(files.keys()), folders: new Set([...base.folded.groups.keys()].filter((d) => d !== ".")) }),
    [files, base],
  );

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

  const goToFolder = useCallback((dir: string) => {
    setSelection({ kind: "group", dir });
    setHover(null);
  }, []);

  const answerKey =
    selection?.kind === "file" ? `file:${selection.path}` : selection?.kind === "group" ? `folder:${selection.dir}` : null;

  const explain = useCallback(async () => {
    if (!selection || !answerKey) return;
    const key = answerKey;
    const update = (a: Asked) => setAnswers((prev) => new Map(prev).set(key, a));
    update({ status: "asking" });
    const res =
      selection.kind === "file"
        ? await explainFileAction(analysisId, selection.path)
        : await explainFolderAction(analysisId, selection.dir);
    if (!res.ok) return update({ status: "failed", message: res.message });
    update({ status: "done", answer: res, freshness: selection.kind === "file" ? "checking" : null });
    if (selection.kind === "file") {
      const freshness = await freshnessAction(analysisId, selection.path);
      setAnswers((prev) => {
        const current = prev.get(key);
        return current?.status === "done" ? new Map(prev).set(key, { ...current, freshness }) : prev;
      });
    }
  }, [selection, answerKey, analysisId]);

  const reanalyse = useCallback(() => {
    setReanalyseError(null);
    startReanalyse(async () => {
      // Redirects to the new run's progress; it only returns if it couldn't start.
      const res = await reanalyseAction(analysisId);
      setReanalyseError(res.error);
    });
  }, [analysisId]);

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
        {/* Clicking an entry dims the rest of the map rather than removing it,
            so the shape of the repository stays on screen. */}
        <div aria-label="Kinds of file" className="min-h-0 flex-1 overflow-y-auto py-2">
          {rail.groups.map((group, g) => (
            <section key={group.heading ?? "kinds"} className={g > 0 ? "mt-2 border-t border-border pt-2" : undefined}>
              {group.heading && (
                <h3 className="flex h-6 items-center px-3 text-[11px] font-medium text-fg-muted">{group.heading}</h3>
              )}
              <ul>
                {group.entries.map((entry) => {
                  const on = filter?.key === entry.key;
                  return (
                    <li key={entry.key}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={entry.count === 0}
                        onClick={() => {
                          setFilter(on ? null : entry);
                          setShowRoutes(false);
                        }}
                        className={`flex h-7 w-full items-center gap-2 px-3 text-left text-xs disabled:text-fg-muted ${
                          on
                            ? "bg-surface-2 font-medium"
                            : filter !== null
                              ? "text-fg-muted enabled:hover:bg-surface-2 enabled:hover:text-fg"
                              : "enabled:hover:bg-surface-2"
                        }`}
                      >
                        {entry.swatch && (
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-[2px]"
                            style={{ background: `var(--cat-${entry.swatch})` }}
                          />
                        )}
                        <span className="flex-1 truncate">{entry.label}</span>
                        <span className="font-mono text-[11px] tabular-nums text-fg-muted">{entry.count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="shrink-0 border-t border-border py-1">
          <button
            type="button"
            aria-pressed={showRoutes}
            onClick={() => setShowRoutes((v) => !v)}
            className={`flex h-7 w-full items-center gap-2 px-3 text-left text-xs hover:bg-surface-2 ${
              showRoutes ? "bg-surface-2 font-medium" : ""
            }`}
          >
            <span className="flex-1">{showRoutes ? "Back to the map" : "Routes"}</span>
            {!showRoutes && (
              <span className="font-mono text-[11px] tabular-nums text-fg-muted">{result.routes.length}</span>
            )}
          </button>
        </div>
        <div className="shrink-0 border-t border-border p-2">
          <ThemeControl initial={theme} />
        </div>
      </aside>

      <main className="flex min-h-0 flex-col bg-bg">
        <CoverageBanner coverage={result.coverage} />
        <div className="relative min-h-0 flex-1">
          {showRoutes ? (
            <RoutesTable
              routes={result.routes}
              withheld={result.routesWithheld}
              frameworks={summary.frameworks}
              selected={selection?.kind === "file" ? selection.path : null}
              onGo={goToFile}
            />
          ) : (
            <MapCanvas
              base={base}
              open={open}
              filter={filter}
              selection={selection}
              onOpen={openFolder}
              onClose={closeFolder}
              onSelectFile={toggleFile}
              onClear={clear}
            />
          )}
        </div>
      </main>

      <aside aria-label={askOpen ? "Ask" : "Details"} className="min-h-0 border-l border-border bg-surface">
        {askOpen ? (
          <AskPane
            name={name}
            conversation={conversation}
            selected={
              selection?.kind === "file"
                ? { kind: "file", path: selection.path }
                : selection?.kind === "group" && selection.dir !== "."
                  ? { kind: "folder", path: selection.dir }
                  : null
            }
            known={known}
            onGo={goToFile}
            onGoFolder={goToFolder}
            onClose={() => setAskOpen(false)}
          />
        ) : (
          <DetailPane
            name={name}
            summary={summary}
            labelNote={result.labelNote ?? null}
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
            explanation={{
              asked: answerKey ? answers.get(answerKey) : undefined,
              onExplain: explain,
              known,
              onGoFolder: goToFolder,
              onReanalyse: reanalyse,
              reanalysing,
              reanalyseError,
            }}
            askToggle={<AskToggle on={false} onToggle={() => setAskOpen(true)} />}
          />
        )}
      </aside>
    </HoverContext.Provider>
  );
}
