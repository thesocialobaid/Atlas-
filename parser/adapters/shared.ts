import { ts } from "ts-morph";
import type { AdapterInput } from "../adapter.ts";
import type { Withheld } from "../types.ts";

const SCRIPT = /\.[mc]?[jt]sx?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isScript(path: string): boolean {
  return SCRIPT.test(path) && !path.endsWith(".d.ts");
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Directories ("" for the root) whose package.json depends on `name`. This is
 * how a framework is recognised: a project that declares it, not a file that
 * looks like it might belong to it.
 */
export function packagesDepending(input: AdapterInput, name: string): string[] {
  const out: string[] = [];
  for (const f of input.files) {
    if (f.path !== "package.json" && !f.path.endsWith("/package.json")) continue;
    if (f.path.split("/").includes("node_modules")) continue;
    const text = input.read(f.path);
    if (text === null) continue;
    try {
      const pkg: unknown = JSON.parse(text);
      if (!isRecord(pkg)) continue;
      const declared = ["dependencies", "devDependencies", "peerDependencies"].some((key) => {
        const deps = pkg[key];
        return isRecord(deps) && name in deps;
      });
      if (declared) out.push(f.folder === "." ? "" : f.folder);
    } catch {
      // A broken package.json declares nothing.
    }
  }
  return out;
}

/** Syntax only: no types, no other files, nothing resolved. */
export function syntaxOf(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** The value of a string written literally, or null for anything computed. */
export function literalString(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

type Group = Omit<Withheld, "framework">;

/** Collects routes that couldn't be read exactly, grouped by why. */
export function withheldList() {
  const groups = new Map<string, Group>();
  return {
    add(reason: string, where: string, count = 1) {
      const g = groups.get(reason) ?? { reason, count: 0, examples: [] };
      g.count += count;
      if (g.examples.length < 5) g.examples.push(where);
      groups.set(reason, g);
    },
    list(): Group[] {
      return [...groups.values()].sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
    },
  };
}

/**
 * Directories holding a manifest that declares a dependency. `matches` picks
 * the manifest files by path; `declares` reads one and says whether the
 * dependency is in it. A manifest inside a folder named "requirements" speaks
 * for the folder above it, the way pip projects lay them out.
 */
export function manifestsDeclaring(
  input: AdapterInput,
  matches: (path: string) => boolean,
  declares: (text: string) => boolean,
): string[] {
  const out = new Set<string>();
  for (const f of input.files) {
    if (!matches(f.path)) continue;
    const parts = f.path.split("/");
    if (parts.includes("node_modules") || parts.includes("vendor")) continue;
    const text = input.read(f.path);
    if (text === null || !declares(text)) continue;
    let dir = f.folder === "." ? "" : f.folder;
    if (baseName(dir) === "requirements") dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    out.add(dir);
  }
  return [...out];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PYTHON_MANIFEST = /(^|\/)(requirements[^/]*\.(txt|in)|requirements\/[^/]+\.(txt|in)|pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/;

/** A Python distribution named in a requirements file, pyproject, setup or Pipfile. */
export function pythonDepending(input: AdapterInput, name: string): string[] {
  // The name must stand alone: "django" isn't "djangorestframework" or "django-environ".
  const token = new RegExp(`(^|[^A-Za-z0-9_.-])${escape(name)}($|[^A-Za-z0-9_.-])`, "i");
  return manifestsDeclaring(
    input,
    (path) => PYTHON_MANIFEST.test(path),
    (text) => text.split("\n").some((line) => !line.trim().startsWith("#") && token.test(line)),
  );
}

/** Text that names the dependency outside a comment line. */
export function mentions(text: string, needle: string, comment = /^\s*(#|\/\/)/): boolean {
  return text.split("\n").some((line) => !comment.test(line) && line.includes(needle));
}

/** The text between the quotes of a string written with no interpolation, or null. */
export function plainString(node: SyntaxLike | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    // Python: string_start carries any prefix; f-strings, bytes and escapes aren't plain.
    case "string": {
      const start = node.namedChildren.find((c) => c.type === "string_start");
      if (start) {
        if (/[fFbB]/.test(start.text)) return null;
        if (node.namedChildren.some((c) => c.type === "interpolation" || c.type === "escape_sequence")) return null;
        return node.namedChildren.filter((c) => c.type === "string_content").map((c) => c.text).join("");
      }
      // Ruby and PHP single-quoted strings.
      if (node.namedChildren.some((c) => c.type !== "string_content" && c.type !== "string_value")) return null;
      if (node.namedChildren.length === 0) {
        const t = node.text;
        return /^(['"])[^]*\1$/.test(t) ? t.slice(1, -1) : null;
      }
      return node.namedChildren.map((c) => c.text).join("");
    }
    // PHP double-quoted: variables make it computed.
    case "encapsed_string":
      if (node.namedChildren.some((c) => c.type !== "string_content" && c.type !== "string_value")) return null;
      return node.namedChildren.map((c) => c.text).join("");
    // Go and Rust.
    case "interpreted_string_literal":
      if (node.namedChildren.some((c) => c.type === "escape_sequence")) return null;
      return node.text.slice(1, -1);
    case "raw_string_literal":
      return node.text.startsWith("`") ? node.text.slice(1, -1) : node.text.replace(/^r#*"/, "").replace(/"#*$/, "");
    // Rust, Java, C#: escapes and Java text blocks aren't plain; C#'s literal is a leaf, so its text is checked.
    case "string_literal":
      if (node.namedChildren.some((c) => c.type === "escape_sequence" || c.type === "interpolation")) return null;
      if (node.text.startsWith('"""') || node.text.includes("\\") || !node.text.startsWith('"')) return null;
      return node.text.slice(1, -1);
    // C# and Java.
    case "verbatim_string_literal":
      return node.text.slice(2, -1);
    default:
      return null;
  }
}

/** The part of a tree-sitter node the string readers use, so this file needn't import the engine. */
export type SyntaxLike = { type: string; text: string; namedChildren: SyntaxLike[] };

/**
 * A role from naming convention: the file's own name without its extension,
 * or any folder it sits in, matching one of a role's names. First role wins.
 */
export function conventionRole<R extends string>(path: string, table: readonly (readonly [R, readonly string[]])[]): R | null {
  const parts = path.split("/");
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const dirs = parts.slice(0, -1);
  for (const [role, names] of table) {
    if (names.includes(stem) || dirs.some((d) => names.includes(d))) return role;
  }
  return null;
}

/** Every item, if none is missing; null as soon as one is. */
export function allDefined<T>(items: readonly (T | null | undefined)[]): T[] | null {
  const out: T[] = [];
  for (const i of items) {
    if (i === null || i === undefined) return null;
    out.push(i);
  }
  return out;
}
