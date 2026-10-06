// What's on screen for a given fold and set of open folders: the boxes, the
// rows inside open ones, and the file edges regrouped onto whatever now stands
// for each end. Pure, so the counts can be checked from a script.

import type { Edge } from "../../parser/types.ts";
import type { Fold } from "./fold.ts";

/** Rows an open panel shows before it says how many more there are. */
export const MAX_ROWS = 12;

/** Handle key for the "n more" row, which stands for every file not listed. */
export const MORE = "+more";

export type FileEdge = {
  from: string;
  to: string;
  /** Every import between these two files is loaded on demand. */
  dynamic: boolean;
};

export type Row = { path: string; label: string };

export type GroupView = {
  /** The directory this box stands for, "." for the repository root. */
  dir: string;
  label: string;
  files: string[];
  /** Distinct files outside this box that import something in it. */
  fanIn: number;
  /** Distinct files outside this box that something in it imports. */
  fanOut: number;
  open: boolean;
  /** Only when open. Most depended-on first. */
  rows: Row[];
  /** Files in an open box that didn't get a row. */
  hidden: string[];
};

export type ViewEdge = {
  id: string;
  source: string;
  /** File path for a row, MORE for the overflow row, null for a closed box. */
  sourceKey: string | null;
  target: string;
  targetKey: string | null;
  /** The file-level imports this line stands for. */
  pairs: FileEdge[];
  /** Every one of those pairs is on demand, so the line draws dashed. */
  dynamic: boolean;
};

export type View = { groups: GroupView[]; edges: ViewEdge[] };

/**
 * Imports of several kinds between the same two files are one connection. It
 * counts as on demand only if nothing else ties the two files together: one
 * static import alongside a dynamic one means the file is loaded up front.
 */
export function fileEdges(edges: readonly Edge[]): FileEdge[] {
  const byPair = new Map<string, FileEdge>();
  for (const e of edges) {
    const key = `${e.from}\n${e.to}`;
    const seen = byPair.get(key);
    if (seen) seen.dynamic &&= e.kind === "dynamic";
    else byPair.set(key, { from: e.from, to: e.to, dynamic: e.kind === "dynamic" });
  }
  return [...byPair.values()];
}

/**
 * The shortest trailing run of path segments that no other item on screen
 * shares. Two items with the same full path can't happen: dirs and files are
 * distinct paths in one tree.
 */
export function shortestUnique(paths: readonly string[]): Map<string, string> {
  const segs = new Map(paths.map((p) => [p, p.split("/")]));
  const suffix = (p: string, k: number) => segs.get(p)!.slice(-k).join("/");
  const labels = new Map<string, string>();
  for (const p of paths) {
    const own = segs.get(p)!;
    let k = 1;
    for (; k < own.length; k++) {
      const s = suffix(p, k);
      if (!paths.some((q) => q !== p && suffix(q, k) === s)) break;
    }
    labels.set(p, suffix(p, k));
  }
  return labels;
}

export function buildView(
  fold: Fold,
  edges: readonly FileEdge[],
  fileFanIn: ReadonlyMap<string, number>,
  open: ReadonlySet<string>,
  /** A file that must get a row if its box is open: the selected one. */
  pinned: string | null = null,
): View {
  const dirs = [...fold.groups.keys()];

  const fanIn = new Map<string, Set<string>>(dirs.map((d) => [d, new Set()]));
  const fanOut = new Map<string, Set<string>>(dirs.map((d) => [d, new Set()]));
  for (const e of edges) {
    const a = fold.groupOf.get(e.from)!;
    const b = fold.groupOf.get(e.to)!;
    if (a === b) continue;
    fanIn.get(b)!.add(e.from);
    fanOut.get(a)!.add(e.to);
  }

  const shown = new Map<string, { rows: string[]; hidden: string[] }>();
  for (const dir of dirs) {
    if (!open.has(dir)) continue;
    const ranked = [...fold.groups.get(dir)!].sort(
      (a, b) => (fileFanIn.get(b) ?? 0) - (fileFanIn.get(a) ?? 0) || (a < b ? -1 : 1),
    );
    // Showing MAX_ROWS - 1 rows and a "1 more" line hides nothing worth hiding.
    const fits = ranked.length <= MAX_ROWS;
    // A selected file ranked past the cut takes the last listed row's place,
    // so selecting it from the pane lands on a row rather than "n more".
    const at = pinned === null ? -1 : ranked.indexOf(pinned);
    if (!fits && at >= MAX_ROWS - 1) ranked.splice(MAX_ROWS - 2, 0, ...ranked.splice(at, 1));
    shown.set(dir, {
      rows: fits ? ranked : ranked.slice(0, MAX_ROWS - 1),
      hidden: fits ? [] : ranked.slice(MAX_ROWS - 1),
    });
  }

  // Labels are unique across everything visible: box names and row names alike.
  // The root is shown as "/" but labelled apart so it never collides.
  const visiblePaths = [
    ...dirs.filter((d) => d !== "."),
    ...[...shown.values()].flatMap((s) => s.rows),
  ];
  const labels = shortestUnique(visiblePaths);

  const groups: GroupView[] = dirs.map((dir) => {
    const s = shown.get(dir);
    return {
      dir,
      label: dir === "." ? "/" : labels.get(dir)!,
      files: fold.groups.get(dir)!,
      fanIn: fanIn.get(dir)!.size,
      fanOut: fanOut.get(dir)!.size,
      open: s !== undefined,
      rows: s ? s.rows.map((path) => ({ path, label: labels.get(path)! })) : [],
      hidden: s ? s.hidden : [],
    };
  });

  const hiddenSet = new Set([...shown.values()].flatMap((s) => s.hidden));
  const keyOf = (path: string, dir: string): string | null =>
    !shown.has(dir) ? null : hiddenSet.has(path) ? MORE : path;

  const merged = new Map<string, ViewEdge>();
  for (const e of edges) {
    const a = fold.groupOf.get(e.from)!;
    const b = fold.groupOf.get(e.to)!;
    // An import inside one box isn't drawn: on a closed box it has nowhere to
    // go, and inside an open one it would loop over the rows. It still counts
    // for selection, which reads the file edges directly.
    if (a === b) continue;
    const sourceKey = keyOf(e.from, a);
    const targetKey = keyOf(e.to, b);
    const id = `${a}\u0000${sourceKey ?? ""}\u0000${b}\u0000${targetKey ?? ""}`;
    let edge = merged.get(id);
    if (!edge) {
      edge = { id, source: a, sourceKey, target: b, targetKey, pairs: [], dynamic: true };
      merged.set(id, edge);
    }
    edge.pairs.push(e);
    edge.dynamic &&= e.dynamic;
  }

  return { groups, edges: [...merged.values()].sort((x, y) => (x.id < y.id ? -1 : 1)) };
}

/**
 * How each neighbour relates to the selection. "in" imports something
 * selected; "out" is imported by it. A file can be both.
 */
export type Relation = { in: boolean; out: boolean };

export function relations(
  selected: ReadonlySet<string>,
  edges: readonly FileEdge[],
): Map<string, Relation> {
  const out = new Map<string, Relation>();
  const mark = (path: string, side: keyof Relation) => {
    const r = out.get(path) ?? { in: false, out: false };
    r[side] = true;
    out.set(path, r);
  };
  for (const e of edges) {
    if (selected.has(e.to) && !selected.has(e.from)) mark(e.from, "in");
    if (selected.has(e.from) && !selected.has(e.to)) mark(e.to, "out");
  }
  return out;
}

/** What a selection keeps at full strength: itself and everything one edge away. */
export function litFiles(selected: ReadonlySet<string>, edges: readonly FileEdge[]): Set<string> {
  const lit = new Set(selected);
  for (const e of edges) {
    if (selected.has(e.from)) lit.add(e.to);
    if (selected.has(e.to)) lit.add(e.from);
  }
  return lit;
}
