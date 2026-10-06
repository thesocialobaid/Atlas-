"use client";

import "@xyflow/react/dist/base.css";
import { ReactFlow, ReactFlowProvider, useReactFlow, type Edge } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import type { Category } from "@/lib/map/categories";
import type { Fold } from "@/lib/map/fold";
import { layout } from "@/lib/map/layout";
import { buildView, litFiles, relations, type FileEdge, type Relation } from "@/lib/map/view";
import { Folded, Panel, type FoldedNode, type PanelNode } from "./nodes";
import type { Selection } from "./state";

const nodeTypes = { folded: Folded, panel: Panel };

export type Base = {
  folded: Fold;
  edges: FileEdge[];
  fanIn: Map<string, number>;
  categories: Map<string, Category>;
};

type Props = {
  base: Base;
  open: ReadonlySet<string>;
  selection: Selection;
  onOpen: (dir: string) => void;
  onClose: (dir: string) => void;
  /** A row was clicked. Clicking the selected row again clears it. */
  onSelectFile: (path: string) => void;
  onClear: () => void;
};

export function MapCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ base, open, selection, onOpen, onClose, onSelectFile, onClear }: Props) {
  const { fitView, getZoom } = useReactFlow();

  const pinned = selection?.kind === "file" ? selection.path : null;
  const view = useMemo(
    () => buildView(base.folded, base.edges, base.fanIn, open, pinned),
    [base, open, pinned],
  );
  const placed = useMemo(() => layout(view), [view]);

  const selected = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "file") return new Set([selection.path]);
    return new Set(base.folded.groups.get(selection.dir) ?? []);
  }, [selection, base]);
  const lit = useMemo(() => (selected ? litFiles(selected, base.edges) : null), [selected, base]);
  const related = useMemo(
    () => (selected ? relations(selected, base.edges) : new Map<string, Relation>()),
    [selected, base],
  );

  const nodes = useMemo<(FoldedNode | PanelNode)[]>(() => {
    // React Flow gives a node no pointer events unless it's draggable or
    // selectable through React Flow itself. Neither is true here: the buttons
    // inside each node handle their own clicks, so the node has to let them.
    const clickable = { pointerEvents: "all" } as const;

    return placed.map((g) =>
      g.open
        ? {
            id: g.dir,
            type: "panel",
            position: { x: g.x, y: g.y },
            width: g.width,
            height: g.height,
            style: clickable,
            data: {
              group: g,
              lit,
              selected: selection?.kind === "file" ? selection.path : null,
              selectedGroup: selection?.kind === "group" && selection.dir === g.dir,
              relations: related,
              categories: base.categories,
              onClose,
              onSelect: onSelectFile,
            },
          }
        : {
            id: g.dir,
            type: "folded",
            position: { x: g.x, y: g.y },
            width: g.width,
            height: g.height,
            style: clickable,
            data: { group: g, dim: lit !== null && !g.files.some((p) => lit.has(p)), onOpen },
          },
    );
  }, [placed, lit, selection, related, base, onOpen, onClose, onSelectFile]);

  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((e) => {
        // Colour is direction relative to the selection: green flows into it,
        // amber flows out. With nothing selected, an edge is just grey.
        const into = selected !== null && e.pairs.some((p) => selected.has(p.to));
        const out = selected !== null && e.pairs.some((p) => selected.has(p.from));
        const stroke = into ? "var(--incoming)" : out ? "var(--outgoing)" : "var(--fg-muted)";
        const opacity = selected === null ? 0.45 : into || out ? 0.9 : 0.08;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceKey === null ? "out" : `out:${e.sourceKey}`,
          targetHandle: e.targetKey === null ? "in" : `in:${e.targetKey}`,
          style: {
            stroke,
            opacity,
            strokeWidth: Math.min(2, 0.75 + Math.log2(e.pairs.length) / 3),
            // Dashed: loaded only on demand. Solid: loaded with the file.
            strokeDasharray: e.dynamic ? "4 3" : undefined,
          },
          // Bright lines draw over dimmed ones where they cross.
          zIndex: into || out ? 1 : 0,
          focusable: false,
        };
      }),
    [view, selected],
  );

  // Folders open from the map and from the pane, so the refit watches what
  // opened rather than who opened it. It runs once the nodes for the new open
  // set exist; fitting earlier would measure the layout from before the open.
  const fitted = useRef(open);
  useEffect(() => {
    const opened = [...open].filter((d) => !fitted.current.has(d));
    fitted.current = open;
    if (opened.length === 0) return;
    // Capped at the current zoom: fitting a panel may zoom out to show it,
    // never in, which would lose the rest of the map.
    void fitView({ nodes: opened.map((id) => ({ id })), padding: 0.25, maxZoom: getZoom(), duration: 200 });
  }, [nodes, open, fitView, getZoom]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onPaneClick={onClear}
      fitView
      fitViewOptions={{ padding: 0.06, maxZoom: 1.25 }}
      minZoom={0.1}
      maxZoom={2}
    />
  );
}
