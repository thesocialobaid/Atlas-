// Arithmetic over the edge list: how far a change travels, what a file needs,
// and the four insights. Pure functions over files and edges, nothing else,
// so every answer can be checked from a script and returns instantly.

import type { RepoFile } from "../../parser/types.ts";
import { categoryOf } from "./categories.ts";
import type { FileEdge } from "./view.ts";

/** Deeper than this returns most of the repository and stops being an answer. */
export const REACH_DEPTH = 2;

/**
 * "dependents" walks to the files that import this one, then the files that
 * import those: what breaks if it changes. "dependencies" walks the other way:
 * what it needs.
 */
export type Direction = "dependents" | "dependencies";

export type Reached = { path: string; depth: number };

/**
 * Breadth-first, so each file is listed at the shortest distance it can be
 * reached. The start file is never part of its own answer, even through a
 * cycle.
 */
export function reach(
  edges: readonly FileEdge[],
  start: string,
  direction: Direction,
  depth: number = REACH_DEPTH,
): Reached[] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const [from, to] = direction === "dependencies" ? [e.from, e.to] : [e.to, e.from];
    (next.get(from) ?? next.set(from, []).get(from)!).push(to);
  }
  const seen = new Set([start]);
  const out: Reached[] = [];
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const level: string[] = [];
    for (const p of frontier) {
      for (const q of next.get(p) ?? []) {
        if (seen.has(q)) continue;
        seen.add(q);
        level.push(q);
      }
    }
    level.sort();
    out.push(...level.map((path) => ({ path, depth: d })));
    frontier = level;
  }
  return out;
}

/**
 * Every import cycle, one per strongly connected component, each given as a
 * real loop you can walk: every file in the list imports the next, and the
 * last imports the first. A file importing itself is a cycle of one.
 *
 * Tarjan's algorithm with an explicit stack. A real repository's import
 * chains are deep enough to overflow a recursive version.
 */
export function cycles(paths: readonly string[], edges: readonly FileEdge[]): string[][] {
  const out = new Map<string, string[]>();
  for (const p of paths) out.set(p, []);
  for (const e of edges) out.get(e.from)?.push(e.to);
  for (const list of out.values()) list.sort();

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of [...paths].sort()) {
    if (index.has(root)) continue;
    // Each frame is a file and how many of its edges have been followed.
    const work: [string, number][] = [[root, 0]];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const targets = out.get(v)!;
      if (i < targets.length) {
        frame[1]++;
        const w = targets[i];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        const selfLoop = component.length === 1 && targets.includes(v);
        if (component.length > 1 || selfLoop) components.push(component);
      }
    }
  }

  return components
    .map((c) => loopThrough(c, out))
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

/**
 * One concrete loop inside a component, starting from its first file by name:
 * the shortest path from that file back to itself. A component can hold many
 * loops; this shows one that provably exists rather than the whole tangle.
 */
function loopThrough(component: string[], out: ReadonlyMap<string, string[]>): string[] {
  const members = new Set(component);
  const start = [...component].sort()[0];
  const parent = new Map<string, string>();
  let frontier = [start];
  while (frontier.length > 0) {
    const level: string[] = [];
    for (const p of frontier) {
      for (const q of out.get(p)!) {
        if (!members.has(q)) continue;
        if (q === start) {
          const loop = [p];
          while (loop[0] !== start) loop.unshift(parent.get(loop[0])!);
          return loop;
        }
        if (parent.has(q)) continue;
        parent.set(q, p);
        level.push(q);
      }
    }
    frontier = level;
  }
  // Unreachable for a strongly connected component; kept so the type is total.
  return [start];
}

/** The four insights. Each kind's sentence is fixed; only the files vary. */
export const INSIGHT_TEXT = {
  unimported: "Nothing in this repository imports this file.",
  heavy: "Imported by far more files than most files here.",
  cycle: "These files import each other in a loop.",
  long: "Longer than 500 lines.",
} as const;

/** Code files longer than this many lines are listed as long. */
export const LONG_LINES = 500;

/** However skewed the spread, fewer importers than this is never unusual. */
const HEAVY_FLOOR = 5;

export type Insights = {
  /** Most imports out first: the files that pull in most are read first. */
  unimported: { path: string; imports: number }[];
  /** Above the cutoff, most imported first. */
  heavy: { path: string; importedBy: number }[];
  heavyCutoff: number;
  cycles: string[][];
  long: { path: string; lines: number }[];
};

/** The value below which a share p of the sorted list falls; nearest rank. */
function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

export function insights(files: readonly RepoFile[], edges: readonly FileEdge[]): Insights {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of edges) {
    fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
  }

  // Files a framework reaches without an import carry a role from an adapter,
  // and config is read by tools, not imported. Neither is listed: their having
  // no importers says nothing about the code. Skipped files are left out too,
  // because their imports were never read.
  const unimported = files
    .filter((f) => f.status === "parsed" && !fanIn.has(f.path) && f.role === null && categoryOf(f) !== "config")
    .map((f) => ({ path: f.path, imports: fanOut.get(f.path) ?? 0 }))
    .sort((a, b) => b.imports - a.imports || (a.path < b.path ? -1 : 1));

  // Unusual is relative to this repository: above the upper fence (Q3 plus
  // one and a half times the interquartile range) of files imported at all.
  const counts = [...fanIn.values()].sort((a, b) => a - b);
  const q1 = counts.length ? quantile(counts, 0.25) : 0;
  const q3 = counts.length ? quantile(counts, 0.75) : 0;
  const heavyCutoff = Math.max(HEAVY_FLOOR, Math.floor(q3 + 1.5 * (q3 - q1)) + 1);
  const heavy = [...fanIn]
    .filter(([, n]) => n >= heavyCutoff)
    .map(([path, importedBy]) => ({ path, importedBy }))
    .sort((a, b) => b.importedBy - a.importedBy || (a.path < b.path ? -1 : 1));

  const long = files
    .filter((f) => categoryOf(f) === "code" && f.lines !== null && f.lines > LONG_LINES)
    .map((f) => ({ path: f.path, lines: f.lines! }))
    .sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1));

  return {
    unimported,
    heavy,
    heavyCutoff,
    cycles: cycles(
      files.map((f) => f.path),
      edges,
    ),
    long,
  };
}
