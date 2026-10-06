// Sizes and positions for what's on screen. Deterministic: the same view gives
// the same picture, because dagre is, and everything fed to it is sorted.

import dagre from "@dagrejs/dagre";
import type { GroupView, View } from "./view.ts";

// Labels are monospace at 11px, so width is arithmetic rather than measured.
const CHAR = 6.7;
const PAD_X = 12;
const MIN_WIDTH = 96;
const MAX_WIDTH = 340;

/** A closed box with nothing depending on it; fan-in only ever adds to this. */
const BASE_HEIGHT = 40;
const MAX_EXTRA_HEIGHT = 84;

export const HEADER_HEIGHT = 40;
export const ROW_HEIGHT = 20;
const PANEL_PAD_Y = 4;

/** Isolated boxes are packed in rows under the connected drawing. */
const GAP = 16;
const RANK_GAP = 72;

export type Placed = GroupView & { x: number; y: number; width: number; height: number };

function textWidth(chars: number): number {
  return Math.ceil(chars * CHAR) + PAD_X * 2;
}

function metaChars(g: GroupView): number {
  // "26 files  19 in  0 out"
  return `${g.files.length} files  ${g.fanIn} in  ${g.fanOut} out`.length;
}

function sizeOf(g: GroupView, maxFanIn: number): { width: number; height: number } {
  // Width follows the text, so a long name never reads as a heavy folder.
  const header = Math.max(textWidth(g.label.length), textWidth(metaChars(g)));
  if (!g.open) {
    // Square root, so one folder everything leans on doesn't flatten the rest.
    const share = maxFanIn === 0 ? 0 : Math.sqrt(g.fanIn / maxFanIn);
    return {
      width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, header)),
      height: Math.round(BASE_HEIGHT + MAX_EXTRA_HEIGHT * share),
    };
  }
  // Rows carry a swatch before the label.
  const widest = Math.max(0, ...g.rows.map((r) => r.label.length));
  const rows = g.rows.length + (g.hidden.length ? 1 : 0);
  return {
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, header, textWidth(widest) + 14)),
    height: HEADER_HEIGHT + rows * ROW_HEIGHT + PANEL_PAD_Y * 2,
  };
}

export function layout(view: View): Placed[] {
  const maxFanIn = Math.max(0, ...view.groups.map((g) => g.fanIn));
  const sized = view.groups.map((g) => ({ ...g, ...sizeOf(g, maxFanIn) }));

  const linked = new Set(view.edges.flatMap((e) => [e.source, e.target]));
  const g = new dagre.graphlib.Graph();
  // Importers on the left, what they import on the right.
  g.setGraph({ rankdir: "LR", nodesep: GAP, ranksep: RANK_GAP, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of sized) if (linked.has(n.dir)) g.setNode(n.dir, { width: n.width, height: n.height });
  const pairs = new Set<string>();
  for (const e of view.edges) {
    const key = `${e.source}\u0000${e.target}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  const placed: Placed[] = [];
  let right = 0;
  let bottom = 0;
  for (const n of sized) {
    if (!linked.has(n.dir)) continue;
    const { x, y } = g.node(n.dir);
    const left = x - n.width / 2;
    const top = y - n.height / 2;
    placed.push({ ...n, x: left, y: top });
    right = Math.max(right, left + n.width);
    bottom = Math.max(bottom, top + n.height);
  }

  // Boxes with no edges in or out would all land in dagre's first rank as one
  // tall column. Packed underneath instead, they keep the drawing wide enough
  // for the canvas, and their own row says they connect to nothing.
  const rowWidth = Math.max(right, 720);
  let x = 0;
  let y = placed.length ? bottom + RANK_GAP : 0;
  let rowHeight = 0;
  for (const n of sized) {
    if (linked.has(n.dir)) continue;
    if (x > 0 && x + n.width > rowWidth) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    placed.push({ ...n, x, y });
    x += n.width + GAP;
    rowHeight = Math.max(rowHeight, n.height);
  }
  return placed;
}
