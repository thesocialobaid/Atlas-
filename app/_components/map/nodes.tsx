"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { Category } from "@/lib/map/categories";
import { HEADER_HEIGHT, ROW_HEIGHT, type Placed } from "@/lib/map/layout";
import { MORE, type Relation } from "@/lib/map/view";
import { paneHovers, useHover } from "./state";

// Handles are only anchors for edges; nothing is connected by hand here. Inside
// a panel each row is positioned, so its anchors sit at that row's centre.
const anchor: CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  pointerEvents: "none",
};

const DIM = "opacity-25";

/** Pointer events that tell the pane which files are under the pointer. */
function useHoverProps(paths: readonly string[]) {
  const { hover, setHover } = useHover();
  return {
    // The pane pointing here. The pointer's own hover is drawn by CSS.
    pointed: paneHovers(hover, paths),
    events: {
      onMouseEnter: () => setHover({ from: "map", paths: new Set(paths) }),
      onMouseLeave: () => setHover(null),
    },
  };
}

export type FoldedData = { group: Placed; dim: boolean; onOpen: (dir: string) => void };

export type PanelData = {
  group: Placed;
  /** Null when nothing is selected, so nothing is dimmed. */
  lit: ReadonlySet<string> | null;
  /** The selected row's path, if a row is what's selected. */
  selected: string | null;
  /** The whole panel is the selection. */
  selectedGroup: boolean;
  relations: ReadonlyMap<string, Relation>;
  categories: ReadonlyMap<string, Category>;
  onClose: (dir: string) => void;
  onSelect: (path: string) => void;
};

export type FoldedNode = Node<FoldedData, "folded">;
export type PanelNode = Node<PanelData, "panel">;

function Meta({ group }: { group: Placed }) {
  return (
    <span className="flex gap-2 font-mono text-[10px] leading-4 text-fg-muted">
      <span>{group.files.length} files</span>
      <span className={group.fanIn ? "text-incoming" : undefined}>{group.fanIn} in</span>
      <span className={group.fanOut ? "text-outgoing" : undefined}>{group.fanOut} out</span>
    </span>
  );
}

export function Folded({ data }: NodeProps<FoldedNode>) {
  const { group } = data;
  const { pointed, events } = useHoverProps(group.files);
  return (
    <button
      type="button"
      {...events}
      onClick={() => data.onOpen(group.dir)}
      title={`${group.dir === "." ? "repository root" : group.dir}: open`}
      style={{ width: group.width, height: group.height }}
      className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left hover:border-fg hover:bg-surface-2 ${
        pointed ? "border-fg bg-surface-2" : `border-border bg-surface ${data.dim ? DIM : ""}`
      }`}
    >
      <span className="w-full truncate font-mono text-[11px] leading-4 font-medium">{group.label}</span>
      <Meta group={group} />
      <Handle type="target" position={Position.Left} id="in" style={anchor} />
      <Handle type="source" position={Position.Right} id="out" style={anchor} />
    </button>
  );
}

export function Panel({ data }: NodeProps<PanelNode>) {
  const { group, lit, selected, relations } = data;
  const { hover } = useHover();
  const header = useHoverProps(group.files);
  // Something the pane points at is never left dimmed.
  const off = (paths: readonly string[]) =>
    lit !== null && !paths.some((p) => lit.has(p)) && !paneHovers(hover, paths);
  return (
    <div
      style={{ width: group.width, height: group.height }}
      className={`flex flex-col rounded-md border bg-surface ${
        data.selectedGroup ? "border-accent" : "border-fg-muted"
      } ${off(group.files) ? DIM : ""}`}
    >
      <button
        type="button"
        {...header.events}
        onClick={() => data.onClose(group.dir)}
        title={`${group.dir === "." ? "repository root" : group.dir}: close`}
        style={{ height: HEADER_HEIGHT }}
        className="flex shrink-0 flex-col items-start justify-center gap-0.5 rounded-t-md border-b border-border bg-surface-2 px-3 text-left hover:bg-border"
      >
        <span className="w-full truncate font-mono text-[11px] leading-4 font-medium">{group.label}</span>
        <Meta group={group} />
      </button>
      <ul className="py-1">
        {group.rows.map((row) => (
          <FileRow
            key={row.path}
            path={row.path}
            label={row.label}
            selected={row.path === selected}
            dim={off([row.path])}
            relation={relations.get(row.path)}
            category={data.categories.get(row.path) ?? "other"}
            onSelect={data.onSelect}
          />
        ))}
        {group.hidden.length > 0 && <MoreRow hidden={group.hidden} dim={off(group.hidden)} relations={relations} />}
      </ul>
    </div>
  );
}

function FileRow(props: {
  path: string;
  label: string;
  selected: boolean;
  dim: boolean;
  relation: Relation | undefined;
  category: Category;
  onSelect: (path: string) => void;
}) {
  const { pointed, events } = useHoverProps([props.path]);
  return (
    <li style={{ height: ROW_HEIGHT }} className="relative">
      <RelationBars relation={props.relation} />
      <button
        type="button"
        {...events}
        title={props.path}
        onClick={() => props.onSelect(props.path)}
        className={`flex h-full w-full items-center gap-2 px-3 text-left font-mono text-[11px] ${
          props.selected ? "bg-accent-soft text-accent" : pointed ? "bg-surface-2 ring-1 ring-fg ring-inset" : "hover:bg-surface-2"
        } ${props.dim ? DIM : ""}`}
      >
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-[1px]"
          style={{ background: `var(--cat-${props.category})` }}
        />
        <span className="truncate">{props.label}</span>
      </button>
      <Handle type="target" position={Position.Left} id={`in:${props.path}`} style={anchor} />
      <Handle type="source" position={Position.Right} id={`out:${props.path}`} style={anchor} />
    </li>
  );
}

function MoreRow({
  hidden,
  dim,
  relations,
}: {
  hidden: string[];
  dim: boolean;
  relations: ReadonlyMap<string, Relation>;
}) {
  const { pointed, events } = useHoverProps(hidden);
  return (
    <li
      {...events}
      style={{ height: ROW_HEIGHT }}
      className={`relative flex items-center px-3 text-[11px] text-fg-muted ${pointed ? "bg-surface-2 ring-1 ring-fg ring-inset" : ""} ${
        dim ? DIM : ""
      }`}
    >
      <RelationBars relation={merge(hidden.map((p) => relations.get(p)))} />
      {hidden.length} more
      <Handle type="target" position={Position.Left} id={`in:${MORE}`} style={anchor} />
      <Handle type="source" position={Position.Right} id={`out:${MORE}`} style={anchor} />
    </li>
  );
}

// Bars on the side a line would attach: amber on the left where a dependency's
// line arrives, green on the right where a dependent's line leaves. They also
// carry imports between files in the same panel, which aren't drawn as lines.
function RelationBars({ relation }: { relation: Relation | undefined }) {
  if (!relation) return null;
  return (
    <>
      {relation.out && <span aria-hidden="true" className="absolute inset-y-0.5 left-0 w-0.5 bg-outgoing" />}
      {relation.in && <span aria-hidden="true" className="absolute inset-y-0.5 right-0 w-0.5 bg-incoming" />}
    </>
  );
}

function merge(list: (Relation | undefined)[]): Relation | undefined {
  const r = { in: list.some((x) => x?.in), out: list.some((x) => x?.out) };
  return r.in || r.out ? r : undefined;
}
