import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { ImportKind, ImportRecord, ModuleExports, RepoFile } from "./types.ts";

/** What every language handler gets: the file set and a way to judge a path. */
export type Context = {
  root: string;
  /** Every node, by path. */
  files: Map<string, RepoFile>;
  /** Source text of files whose status is "parsed". */
  text: Map<string, string>;
  /** Filled by the JavaScript handler, by path. */
  exports: Map<string, Omit<ModuleExports, "file">>;
};

/**
 * Reads a node's text even when it isn't a parsed language: manifests like
 * package.json and go.mod tell a handler how imports map onto files.
 */
export function readNode(ctx: Context, rel: string): string | null {
  if (!ctx.files.has(rel)) return null;
  const parsed = ctx.text.get(rel);
  if (parsed !== undefined) return parsed;
  try {
    return readFileSync(join(ctx.root, rel), "utf8");
  } catch {
    return null;
  }
}

/** A source file handed to a language: its node and its text. */
export type Source = { file: RepoFile; text: string };

export type LanguageHandler = {
  /** Languages (as named by languageOf) this handler reads. */
  languages: string[];
  /**
   * Reads every file of its languages at once, because some resolution needs
   * the whole set first (a Java import names a class, not a path). May set
   * `module` and `hadSyntaxErrors` on the files it reads.
   */
  analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> | ImportRecord[];
};

/**
 * Judges a candidate repository-relative path. A node is resolved; a real file
 * that isn't a node (ignored by .gitignore) is excluded, never silently
 * promoted; anything else doesn't exist.
 */
export function judgePath(ctx: Context, rel: string): "node" | "ignored" | "missing" {
  if (rel.startsWith("../") || rel === "..") return "missing";
  if (ctx.files.has(rel)) return "node";
  try {
    if (existsSync(join(ctx.root, rel)) && statSync(join(ctx.root, rel)).isFile()) return "ignored";
  } catch {
    // Unreadable counts as missing.
  }
  return "missing";
}

export function isDirWithFiles(ctx: Context, relDir: string): boolean {
  const prefix = relDir === "." || relDir === "" ? "" : `${relDir}/`;
  for (const path of ctx.files.keys()) if (path.startsWith(prefix)) return true;
  return false;
}

/** Joins and normalises; returns null if it climbs out of the repository. */
export function relJoin(...parts: string[]): string | null {
  const joined = posix.normalize(posix.join(...parts));
  if (joined.startsWith("../") || joined === "..") return null;
  return joined === "." ? "" : joined.replace(/\/$/, "");
}

/** Shorthand constructors so every handler reports the same way. */
export const record = {
  resolved(from: string, specifier: string, kind: ImportKind, line: number, to: string[]): ImportRecord {
    return { from, specifier, kind, line, outcome: "resolved", to, reason: null };
  },
  external(from: string, specifier: string, kind: ImportKind, line: number, reason: string): ImportRecord {
    return { from, specifier, kind, line, outcome: "external", to: [], reason };
  },
  excluded(from: string, specifier: string, kind: ImportKind, line: number, reason: string): ImportRecord {
    return { from, specifier, kind, line, outcome: "excluded", to: [], reason };
  },
  unresolved(from: string, specifier: string, kind: ImportKind, line: number, reason: string): ImportRecord {
    return { from, specifier, kind, line, outcome: "unresolved", to: [], reason };
  },
};

/**
 * The common verdict once a handler has a single candidate path for an import:
 * a node is an edge, an ignored file is excluded, anything else unresolved.
 */
export function verdict(
  ctx: Context,
  from: string,
  specifier: string,
  kind: ImportKind,
  line: number,
  candidates: string[],
  missingReason: string,
): ImportRecord {
  for (const c of candidates) {
    const j = judgePath(ctx, c);
    if (j === "node") return record.resolved(from, specifier, kind, line, [c]);
  }
  for (const c of candidates) {
    if (judgePath(ctx, c) === "ignored") {
      return record.excluded(from, specifier, kind, line, `target ${c} is ignored by .gitignore, so it isn't a node`);
    }
  }
  return record.unresolved(from, specifier, kind, line, missingReason);
}
