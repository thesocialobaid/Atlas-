// What each of the agent's six lookups returns, computed from one loaded
// analysis by the same functions that draw the canvas and fill the pane:
// summarise, insights, buildRail, describeFile and reach. Pure, so every
// answer can be checked from a script, and nothing here is new arithmetic.
//
// Answers are plain objects the model reads as JSON. Long lists are cut to a
// fixed length and always say how many there were, so a cut list is never
// mistaken for a complete one.

import { describeFile, summarise } from "../map/detail.ts";
import { insights, reach, REACH_DEPTH, type Direction } from "../map/graph.ts";
import type { MapInput } from "../map/input.ts";
import { buildRail } from "../map/rail.ts";
import { fileEdges } from "../map/view.ts";

/** Rows any one list returns before it says how many more there are. */
export const LIST_LIMIT = 50;

export type Repository = { owner: string; name: string; commit: string | null };

/** A lookup that can't be answered: the model is told why, in a sentence. */
export class LookupError extends Error {}

// A cut list names how many it left out in a field that says so. A bare
// "more" count read as an invitation: the model filled the gap with names.
function capped<T>(items: readonly T[]) {
  return items.length > LIST_LIMIT
    ? { total: items.length, shown: items.slice(0, LIST_LIMIT), notShown: items.length - LIST_LIMIT }
    : { total: items.length, shown: [...items] };
}

/** Everything one analysis needs to answer, derived once per request. */
export function prepare(input: MapInput) {
  const edges = fileEdges(input.edges);
  const files = new Map(input.files.map((f) => [f.path, f]));
  const fan = new Map(input.fan.map((f) => [f.path, f]));
  const rail = buildRail(input.adapters, input.files);
  const labelOf = new Map(rail.groups.flatMap((g) => g.entries.map((e) => [e.key, e.label] as const)));
  /** The rail entry a file is counted under: its role, or its kind when no role claimed it. */
  const roleOf = (path: string) => labelOf.get(rail.entryOf.get(path)!)!;
  return { input, edges, files, fan, rail, roleOf };
}

export type Prepared = ReturnType<typeof prepare>;

function fileRow(p: Prepared, path: string) {
  const f = p.files.get(path)!;
  return {
    path,
    role: p.roleOf(path),
    importedBy: p.fan.get(path)?.fanIn ?? 0,
    imports: p.fan.get(path)?.fanOut ?? 0,
    ...(f.status === "skipped" ? { skipped: f.skipReason } : {}),
  };
}

function requireFile(p: Prepared, path: string) {
  if (!p.files.has(path)) {
    throw new LookupError(`No file at "${path}" in this analysis. Paths are exact; search by part of one to find it.`);
  }
}

export function summary(p: Prepared, repo: Repository) {
  const s = summarise(p.input);
  const found = insights(p.input.files, p.edges);
  const { coverage } = p.input;
  return {
    repository: `${repo.owner}/${repo.name}`,
    commit: repo.commit,
    frameworks: s.frameworks,
    files: {
      found: coverage.filesFound,
      parsed: coverage.filesParsed,
      skipped: coverage.filesSkipped,
      skippedBecause: coverage.skipped.map((g) => ({ reason: g.reason, count: g.count })),
    },
    imports: {
      seen: s.imports,
      resolvedToAFileHere: s.importsBy.resolved,
      external: s.importsBy.external,
      excluded: s.importsBy.excluded,
      unresolved: s.importsBy.unresolved,
    },
    roles: p.rail.groups.flatMap((g) =>
      g.entries.filter((e) => e.count > 0).map((e) => ({ role: e.label, framework: g.heading, files: e.count })),
    ),
    routes: s.routes,
    routesNotReadExactly: s.routesWithheld,
    ...(p.input.labelNote ? { labelling: p.input.labelNote } : {}),
    mostImported: capped(s.leanedOn.map((r) => ({ path: r.path, importedBy: r.count }))),
    importedByNothing: capped(found.unimported),
    importedByUnusuallyMany: { atLeast: found.heavyCutoff, ...capped(found.heavy) },
    importLoops: capped(found.cycles),
    longerThan500Lines: capped(found.long),
  };
}

export function searchFiles(p: Prepared, text: string) {
  const needle = text.trim().toLowerCase();
  if (!needle) throw new LookupError("Search text is empty.");
  const hits = p.input.files.filter((f) => f.path.toLowerCase().includes(needle)).map((f) => fileRow(p, f.path));
  return { search: text, files: capped(hits) };
}

export function filesByRole(p: Prepared, role: string) {
  const entries = p.rail.groups.flatMap((g) => g.entries.map((e) => ({ ...e, framework: g.heading })));
  const wanted = role.trim().toLowerCase();
  const matches = entries.filter((e) => e.label.toLowerCase() === wanted);
  if (matches.length === 0) {
    return {
      role,
      found: false,
      rolesInThisAnalysis: entries.filter((e) => e.count > 0).map((e) => ({ role: e.label, framework: e.framework, files: e.count })),
    };
  }
  const keys = new Set(matches.map((e) => e.key));
  const paths = p.input.files.filter((f) => keys.has(p.rail.entryOf.get(f.path)!)).map((f) => fileRow(p, f.path));
  return { role: matches[0].label, found: true, files: capped(paths) };
}

export function neighbours(p: Prepared, path: string) {
  requireFile(p, path);
  const d = describeFile(p.input, p.files, p.edges, path)!;
  const row = (n: { path: string; dynamic: boolean }) => ({ path: n.path, ...(n.dynamic ? { loadedOnDemand: true } : {}) });
  return {
    ...fileRow(p, path),
    lines: d.file.lines,
    importsFilesHere: capped(d.imports.map(row)),
    importedByFilesHere: capped(d.importedBy.map(row)),
    importsOutsideTheRepository: d.external,
    importsThatCouldNotBeResolved: capped(d.unresolved),
  };
}

export function walk(p: Prepared, path: string, direction: Direction) {
  requireFile(p, path);
  const reached = reach(p.edges, path, direction);
  return {
    from: path,
    direction,
    meaning:
      direction === "dependents"
        ? "files that import this one, then the files that import those: what could break if it changes"
        : "files this one imports, then the files those import: what it needs",
    stepsWalked: REACH_DEPTH,
    reached: capped(reached.map((r) => ({ path: r.path, steps: r.depth }))),
  };
}

export function routes(p: Prepared) {
  const withheld = p.input.routesWithheld;
  return {
    routes: capped(p.input.routes.map((r) => ({ method: r.method, path: r.path, file: r.file, line: r.line }))),
    notReadExactly:
      withheld === null
        ? "This analysis was stored before routes were read."
        : withheld.map((g) => ({ reason: g.reason, count: g.count })),
  };
}
