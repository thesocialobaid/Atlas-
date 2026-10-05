import type { Edge, FanCounts, ImportRecord } from "./types.ts";

// Pure functions over the import list. No I/O.

/** One edge per (from, to, kind); self-imports aren't connections. */
export function edgesFrom(imports: readonly ImportRecord[]): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const imp of imports) {
    if (imp.outcome !== "resolved") continue;
    for (const to of imp.to) {
      if (to === imp.from) continue;
      const key = `${imp.from}\0${to}\0${imp.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: imp.from, to, kind: imp.kind });
    }
  }
  return edges;
}

/**
 * Fan-in and fan-out per file, counting each connected pair once even when a
 * file both imports and re-exports the same neighbour.
 */
export function fanCounts(paths: readonly string[], edges: readonly Edge[]): FanCounts[] {
  const pairs = new Set(edges.map((e) => `${e.from}\0${e.to}`));
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const pair of pairs) {
    const [from, to] = pair.split("\0");
    fanOut.set(from, (fanOut.get(from) ?? 0) + 1);
    fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  }
  return paths.map((path) => ({
    path,
    fanIn: fanIn.get(path) ?? 0,
    fanOut: fanOut.get(path) ?? 0,
  }));
}
