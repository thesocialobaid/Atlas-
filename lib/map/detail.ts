// What the detail pane says, derived from the parser's output and the fold.
// Pure, so every number in the pane can be checked from a script, and so a
// selection never needs a request: it's all arithmetic over what's loaded.

import type { ImportOutcome, RepoFile } from "../../parser/types.ts";
import { CATEGORIES, categoryOf, type Category } from "./categories.ts";
import type { Fold } from "./fold.ts";
import type { MapInput } from "./input.ts";
import type { FileEdge } from "./view.ts";

export type Ranked = { path: string; category: Category; count: number };

export type Summary = {
  framework: string | null;
  files: number;
  imports: number;
  importsBy: Record<ImportOutcome, number>;
  /** Most imported first. Only files something imports. */
  leanedOn: Ranked[];
  /**
   * Parsed files nothing imports, the ones that pull in most first. Skipped
   * files are left out: their imports were never read, so "nothing imports
   * this" says nothing about where reading starts.
   */
  entryPoints: Ranked[];
  /** No adapter gave it a role and its file kind isn't one we know. */
  unidentified: number;
};

const byCountThenPath = (a: Ranked, b: Ranked) => b.count - a.count || (a.path < b.path ? -1 : 1);

export function summarise(result: MapInput): Summary {
  const fan = new Map(result.fan.map((f) => [f.path, f]));
  const ranked = (f: RepoFile, count: number): Ranked => ({ path: f.path, category: categoryOf(f), count });

  return {
    // "none" is the fallback adapter's name: no framework recognised.
    framework: result.adapter === "none" ? null : result.adapter,
    files: result.files.length,
    // Every import seen, resolved or not, from coverage: resolved imports
    // aren't kept one by one, only as the edges they became.
    imports: Object.values(result.coverage.imports).reduce((a, b) => a + b, 0),
    importsBy: result.coverage.imports,
    leanedOn: result.files
      .filter((f) => (fan.get(f.path)?.fanIn ?? 0) > 0)
      .map((f) => ranked(f, fan.get(f.path)!.fanIn))
      .sort(byCountThenPath),
    entryPoints: result.files
      .filter((f) => f.status === "parsed" && (fan.get(f.path)?.fanIn ?? 0) === 0)
      .map((f) => ranked(f, fan.get(f.path)?.fanOut ?? 0))
      .sort(byCountThenPath),
    unidentified: result.files.filter((f) => f.role === null && categoryOf(f) === "other").length,
  };
}

export type Neighbour = { path: string; category: Category; dynamic: boolean };

export type FileDetail = {
  file: RepoFile;
  category: Category;
  /** Files in this repository it imports. */
  imports: Neighbour[];
  /** Files in this repository that import it. */
  importedBy: Neighbour[];
  /** Import statements pointing outside the repository. */
  external: number;
  /** Import statements that should name a file here and couldn't be tied to one. */
  unresolved: { specifier: string; line: number; reason: string }[];
};

export function describeFile(
  result: MapInput,
  files: ReadonlyMap<string, RepoFile>,
  edges: readonly FileEdge[],
  path: string,
): FileDetail | null {
  const file = files.get(path);
  if (!file) return null;
  const neighbour = (p: string, dynamic: boolean): Neighbour => ({
    path: p,
    category: categoryOf(files.get(p)!),
    dynamic,
  });
  const byPath = (a: Neighbour, b: Neighbour) => (a.path < b.path ? -1 : 1);

  const own = result.imports.filter((i) => i.from === path);
  return {
    file,
    category: categoryOf(file),
    imports: edges.filter((e) => e.from === path).map((e) => neighbour(e.to, e.dynamic)).sort(byPath),
    importedBy: edges.filter((e) => e.to === path).map((e) => neighbour(e.from, e.dynamic)).sort(byPath),
    external: own.filter((i) => i.outcome === "external").length,
    unresolved: own
      .filter((i) => i.outcome === "unresolved")
      .map((i) => ({ specifier: i.specifier, line: i.line, reason: i.reason ?? "no reason recorded" })),
  };
}

export type FolderDetail = {
  dir: string;
  files: number;
  /** Every kind present, in the rail's order. */
  kinds: { category: Category; count: number }[];
};

export function describeFolder(
  fold: Fold,
  files: ReadonlyMap<string, RepoFile>,
  dir: string,
): FolderDetail | null {
  const paths = fold.groups.get(dir);
  if (!paths) return null;
  const counts = new Map<Category, number>();
  for (const p of paths) {
    const c = categoryOf(files.get(p)!);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return {
    dir,
    files: paths.length,
    kinds: CATEGORIES.filter((c) => counts.has(c)).map((category) => ({ category, count: counts.get(category)! })),
  };
}
