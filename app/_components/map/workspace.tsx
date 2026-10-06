"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { categoryOf } from "@/lib/map/categories";
import { describeFile, describeFolder, summarise } from "@/lib/map/detail";
import { fold } from "@/lib/map/fold";
import { fileEdges } from "@/lib/map/view";
import type { ParseResult } from "@/parser/types";
import { MapCanvas, type Base } from "./canvas";
import { DetailPane, type Tab } from "./pane";
import { HoverContext, type Hover, type Selection } from "./state";

// The map and the detail pane share one selection, one set of open folders
// and one hover, so they live here rather than in either. Everything the pane
// shows is derived from the result already in the browser: selecting fires no
// request.
export function Workspace({ name, result }: { name: string; result: ParseResult }) {
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

  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Hover>(null);
  // Kept across selections: comparing three explanations shouldn't mean
  // reopening the tab three times.
  const [tab, setTab] = useState<Tab>("structure");

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

  const hoverApi = useMemo(() => ({ hover, setHover }), [hover]);

  return (
    <HoverContext.Provider value={hoverApi}>
      <main className="relative min-h-0 bg-bg">
        <MapCanvas
          base={base}
          open={open}
          selection={selection}
          onOpen={openFolder}
          onClose={closeFolder}
          onSelectFile={toggleFile}
          onClear={clear}
        />
      </main>

      <aside aria-label="Details" className="min-h-0 border-l border-border bg-surface">
        <DetailPane
          name={name}
          summary={summary}
          file={file}
          folder={folder}
          tab={tab}
          onTab={setTab}
          onGo={goToFile}
          onClear={clear}
        />
      </aside>
    </HoverContext.Provider>
  );
}
