import { readFileSync } from "node:fs";
import { HTTP_METHODS, OUTPUT_VERSION } from "./types.ts";
import type { Coverage, Edge, ImportRecord, ModuleExports, ParseResult, RepoFile, Route, SkipReason, Withheld } from "./types.ts";

// Reading a result back checks every field rather than trusting a cast, so a
// stale or hand-edited file fails here, loudly, instead of downstream. The
// same checks apply to rows read back from the database.

class ShapeError extends Error {}

function fail(where: string, expected: string): never {
  throw new ShapeError(`${where}: expected ${expected}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown, w: string): string => (typeof v === "string" ? v : fail(w, "a string"));
const num = (v: unknown, w: string): number => (typeof v === "number" && Number.isFinite(v) ? v : fail(w, "a number"));
const strOrNull = (v: unknown, w: string): string | null => (v === null ? null : str(v, w));
const arr = (v: unknown, w: string): unknown[] => (Array.isArray(v) ? v : fail(w, "an array"));
const obj = (v: unknown, w: string): Record<string, unknown> => (isObj(v) ? v : fail(w, "an object"));
function oneOf<T extends string>(v: unknown, options: readonly T[], w: string): T {
  const hit = options.find((o) => o === v);
  return hit ?? fail(w, options.join(" | "));
}

function isSkipReason(v: string): v is SkipReason {
  return v === "binary file" || v === "larger than 1 MB" || v === "not valid UTF-8 text" || v.startsWith("no import parser for ");
}

const KINDS = ["import", "re-export", "dynamic", "include", "module-declaration", "reference", "require"] as const;
const OUTCOMES = ["resolved", "external", "excluded", "unresolved"] as const;

export function parseRepoFile(v: unknown, w: string): RepoFile {
  const o = obj(v, w);
  const status = oneOf(o.status, ["parsed", "skipped"] as const, `${w}.status`);
  const reasonText = strOrNull(o.skipReason, `${w}.skipReason`);
  const skipReason = reasonText === null ? null : isSkipReason(reasonText) ? reasonText : fail(`${w}.skipReason`, "a known skip reason");
  if ((status === "skipped") !== (skipReason !== null)) fail(`${w}.skipReason`, "a reason exactly when skipped");
  const errors = o.hadSyntaxErrors;
  return {
    path: str(o.path, `${w}.path`),
    folder: str(o.folder, `${w}.folder`),
    language: str(o.language, `${w}.language`),
    lines: o.lines === null ? null : num(o.lines, `${w}.lines`),
    bytes: num(o.bytes, `${w}.bytes`),
    sha256: str(o.sha256, `${w}.sha256`),
    module: strOrNull(o.module, `${w}.module`),
    status,
    skipReason,
    hadSyntaxErrors: errors === null || typeof errors === "boolean" ? errors : fail(`${w}.hadSyntaxErrors`, "boolean | null"),
    role: strOrNull(o.role, `${w}.role`),
    framework: strOrNull(o.framework, `${w}.framework`),
  };
}

export function parseImportRecord(v: unknown, w: string): ImportRecord {
  const o = obj(v, w);
  const outcome = oneOf(o.outcome, OUTCOMES, `${w}.outcome`);
  const reason = strOrNull(o.reason, `${w}.reason`);
  if (outcome !== "resolved" && reason === null) fail(`${w}.reason`, "a reason for every non-resolved import");
  return {
    from: str(o.from, `${w}.from`),
    specifier: str(o.specifier, `${w}.specifier`),
    kind: oneOf(o.kind, KINDS, `${w}.kind`),
    line: num(o.line, `${w}.line`),
    outcome,
    to: arr(o.to, `${w}.to`).map((t, i) => str(t, `${w}.to[${i}]`)),
    reason,
  };
}

export function parseEdge(v: unknown, w: string): Edge {
  const o = obj(v, w);
  return { from: str(o.from, `${w}.from`), to: str(o.to, `${w}.to`), kind: oneOf(o.kind, KINDS, `${w}.kind`) };
}

export function parseModuleExports(v: unknown, w: string): ModuleExports {
  const o = obj(v, w);
  const names = o.names === null ? null : arr(o.names, `${w}.names`).map((n, i) => str(n, `${w}.names[${i}]`));
  const reason = strOrNull(o.reason, `${w}.reason`);
  if ((names === null) !== (reason !== null)) fail(`${w}.reason`, "a reason exactly when names is null");
  return { file: str(o.file, `${w}.file`), names, reason };
}

export function parseRoute(v: unknown, w: string): Route {
  const o = obj(v, w);
  const path = str(o.path, `${w}.path`);
  if (!path.startsWith("/")) fail(`${w}.path`, "a pattern starting with /");
  return {
    framework: str(o.framework, `${w}.framework`),
    file: str(o.file, `${w}.file`),
    method: oneOf(o.method, HTTP_METHODS, `${w}.method`),
    path,
    line: num(o.line, `${w}.line`),
  };
}

export function parseWithheld(v: unknown, w: string): Withheld {
  const o = obj(v, w);
  return {
    framework: str(o.framework, `${w}.framework`),
    reason: str(o.reason, `${w}.reason`),
    count: num(o.count, `${w}.count`),
    examples: arr(o.examples, `${w}.examples`).map((e, i) => str(e, `${w}.examples[${i}]`)),
  };
}

export function readParseResult(path: string): ParseResult {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const o = obj(raw, "result");
  if (o.version !== OUTPUT_VERSION) fail("result.version", `${OUTPUT_VERSION}`);
  const files = arr(o.files, "files").map((f, i) => parseRepoFile(f, `files[${i}]`));
  const paths = new Set(files.map((f) => f.path));
  const edges = arr(o.edges, "edges").map((e, i) => parseEdge(e, `edges[${i}]`));
  // The rule everything rests on: an edge only joins two real nodes.
  edges.forEach((e, i) => {
    if (!paths.has(e.from) || !paths.has(e.to)) fail(`edges[${i}]`, "both ends to be files in the result");
  });
  const result: ParseResult = {
    version: OUTPUT_VERSION,
    root: str(o.root, "root"),
    generatedAt: str(o.generatedAt, "generatedAt"),
    fileSource: oneOf(o.fileSource, ["git", "walk"] as const, "fileSource"),
    adapters: arr(o.adapters, "adapters").map((a, i) => str(a, `adapters[${i}]`)),
    files,
    imports: arr(o.imports, "imports").map((r, i) => parseImportRecord(r, `imports[${i}]`)),
    edges,
    fan: arr(o.fan, "fan").map((f, i) => {
      const x = obj(f, `fan[${i}]`);
      return { path: str(x.path, `fan[${i}].path`), fanIn: num(x.fanIn, `fan[${i}].fanIn`), fanOut: num(x.fanOut, `fan[${i}].fanOut`) };
    }),
    exports: arr(o.exports, "exports").map((e, i) => parseModuleExports(e, `exports[${i}]`)),
    coverage: parseCoverage(o.coverage),
    routes: arr(o.routes, "routes").map((r, i) => parseRoute(r, `routes[${i}]`)),
    routesWithheld: arr(o.routesWithheld, "routesWithheld").map((r, i) => parseWithheld(r, `routesWithheld[${i}]`)),
  };
  // A route belongs to a file that's a node, like an edge's two ends.
  result.routes.forEach((r, i) => {
    if (!paths.has(r.file)) fail(`routes[${i}].file`, "a file in the result");
  });
  result.exports.forEach((e, i) => {
    if (!paths.has(e.file)) fail(`exports[${i}].file`, "a file in the result");
  });
  return result;
}

/** The coverage summary, checked field by field. */
export function parseCoverage(v: unknown): Coverage {
  const cov = obj(v, "coverage");
  const coverage: Coverage = {
  filesFound: num(cov.filesFound, "coverage.filesFound"),
  filesParsed: num(cov.filesParsed, "coverage.filesParsed"),
  filesSkipped: num(cov.filesSkipped, "coverage.filesSkipped"),
  skipped: arr(cov.skipped, "coverage.skipped").map((s, i) => {
    const x = obj(s, `coverage.skipped[${i}]`);
    return {
      reason: str(x.reason, `coverage.skipped[${i}].reason`),
      count: num(x.count, `coverage.skipped[${i}].count`),
      examples: arr(x.examples, `coverage.skipped[${i}].examples`).map((e, j) => str(e, `coverage.skipped[${i}].examples[${j}]`)),
    };
  }),
  folders: num(cov.folders, "coverage.folders"),
  imports: (() => {
    const x = obj(cov.imports, "coverage.imports");
    return {
      resolved: num(x.resolved, "coverage.imports.resolved"),
      external: num(x.external, "coverage.imports.external"),
      excluded: num(x.excluded, "coverage.imports.excluded"),
      unresolved: num(x.unresolved, "coverage.imports.unresolved"),
    };
  })(),
  byKind: arr(cov.byKind, "coverage.byKind").map((k, i) => {
    const x = obj(k, `coverage.byKind[${i}]`);
    return { kind: oneOf(x.kind, KINDS, `coverage.byKind[${i}].kind`), seen: num(x.seen, "seen"), resolved: num(x.resolved, "resolved") };
  }),
  reasons: arr(cov.reasons, "coverage.reasons").map((r, i) => {
    const x = obj(r, `coverage.reasons[${i}]`);
    return {
      outcome: oneOf(x.outcome, ["external", "excluded", "unresolved"] as const, `coverage.reasons[${i}].outcome`),
      reason: str(x.reason, `coverage.reasons[${i}].reason`),
      count: num(x.count, `coverage.reasons[${i}].count`),
      examples: arr(x.examples, `coverage.reasons[${i}].examples`).map((e, j) => {
        const y = obj(e, `coverage.reasons[${i}].examples[${j}]`);
        return { from: str(y.from, "from"), specifier: str(y.specifier, "specifier"), line: num(y.line, "line") };
      }),
    };
  }),
};
  if (coverage.filesFound !== coverage.filesParsed + coverage.filesSkipped) {
    fail("coverage", "filesFound = filesParsed + filesSkipped");
  }
  return coverage;
}
