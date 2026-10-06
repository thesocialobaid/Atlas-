// Folding: which directories are drawn as their own box. Pure, over a list of
// file paths and the folder each sits in, so it runs from a plain script.

/** More boxes than this and nobody reads them. */
export const MAX_GROUPS = 24;

/** The first threshold tried: a directory with one file merges upward. */
const START_THRESHOLD = 2;

export type FoldFile = { path: string; folder: string };

export type Fold = {
  /** Directories holding fewer files than this merged into their parent. */
  threshold: number;
  /** Surviving directory → every file it now holds, sorted by path. */
  groups: Map<string, string[]>;
  /** File path → the directory it's drawn inside. */
  groupOf: Map<string, string>;
};

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut === -1 ? "." : dir.slice(0, cut);
}

function depthOf(dir: string): number {
  return dir === "." ? 0 : dir.split("/").length;
}

/** One pass at a fixed threshold. */
export function foldAt(files: readonly FoldFile[], threshold: number): Fold {
  const held = new Map<string, string[]>([[".", []]]);
  for (const f of files) {
    // Every directory is a starting node, including ones that only hold other
    // directories; those start empty and merge up unless something lands in them.
    for (let d = f.folder; d !== "." && !held.has(d); d = parentOf(d)) held.set(d, []);
    held.get(f.folder)!.push(f.path);
  }

  const maxDepth = Math.max(0, ...[...held.keys()].map(depthOf));
  for (let depth = maxDepth; depth >= 1; depth--) {
    // Decide the whole level before applying any of it, so one merge at this
    // depth can't change what another at the same depth sees.
    const merging = [...held.keys()]
      .filter((d) => depthOf(d) === depth && held.get(d)!.length < threshold)
      .sort();
    for (const d of merging) {
      held.get(parentOf(d))!.push(...held.get(d)!);
      held.delete(d);
    }
  }

  const groups = new Map<string, string[]>();
  const groupOf = new Map<string, string>();
  for (const dir of [...held.keys()].sort()) {
    const paths = held.get(dir)!.sort();
    // The root can't merge anywhere; if nothing is in it, it isn't drawn.
    if (paths.length === 0) continue;
    groups.set(dir, paths);
    for (const p of paths) groupOf.set(p, dir);
  }
  return { threshold, groups, groupOf };
}

/**
 * The lowest threshold that lands at or under MAX_GROUPS. Each attempt is a
 * fresh fold from every directory, so the repository's shape decides the depth.
 */
export function fold(files: readonly FoldFile[]): Fold {
  let result = foldAt(files, START_THRESHOLD);
  for (let t = START_THRESHOLD + 1; result.groups.size > MAX_GROUPS && t <= files.length; t++) {
    result = foldAt(files, t);
  }
  return result;
}
