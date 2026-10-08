import { posix } from "node:path";
import { record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// Absolute imports are looked up from the repository root, and from src/ when
// it exists: the two layouts Python packaging documents. A name found in
// neither is outside the repository (standard library or an installed
// package).
//
// A folder that isn't a package (no __init__.py) holds scripts, and running a
// script puts its folder at the front of sys.path, so `import config` beside
// config.py loads that file. Those folders are searched first. Inside a
// package Python 3 never searches the module's own folder, so they aren't.
// An import never resolves to the file doing the importing: pkg/logging.py's
// `import logging` means the standard library, not itself.

// A Python project's own folder is where it runs from, so it's where its
// absolute imports start. A repository can hold several (backend/ beside
// frontend/, services side by side); each is recognised by what only a
// project's root holds: pyproject.toml, setup.py, setup.cfg, manage.py, or a
// requirements file (requirements/base.txt speaks for the folder above).
const PROJECT_FILE = /^(pyproject\.toml|setup\.py|setup\.cfg|manage\.py|requirements[^/]*\.(txt|in))$/;

/** Every project folder, deepest first; the repository root is always last. */
function projectDirs(ctx: Context): string[] {
  const dirs = new Set<string>();
  for (const p of ctx.files.keys()) {
    const parts = p.split("/");
    if (parts.includes("node_modules")) continue;
    let dir: string | null = null;
    if (PROJECT_FILE.test(parts[parts.length - 1])) dir = parts.slice(0, -1).join("/");
    else if (parts.length >= 2 && parts[parts.length - 2] === "requirements" && /\.(txt|in)$/.test(p)) dir = parts.slice(0, -2).join("/");
    if (dir) dirs.add(dir);
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1));
  return [...deepestFirst, ""];
}

/**
 * Roots for one file. Imports are searched in each project it sits in,
 * deepest first, the project folder before its src/ (the two layouts Python
 * packaging documents). Its module name comes from the innermost root that
 * holds it, so src/ is tried before its project there.
 */
function rootsFor(projects: string[], srcDirs: ReadonlySet<string>, path: string): { search: string[]; naming: string[] } {
  const search: string[] = [];
  const naming: string[] = [];
  for (const d of projects) {
    if (d !== "" && !path.startsWith(`${d}/`)) continue;
    const src = d ? `${d}/src` : "src";
    const hasSrc = srcDirs.has(src);
    search.push(d, ...(hasSrc ? [src] : []));
    naming.push(...(hasSrc ? [src] : []), d);
  }
  return { search, naming };
}

function isDirWithPython(ctx: Context, dir: string): boolean {
  for (const p of ctx.files.keys()) if (p.startsWith(`${dir}/`) && p.endsWith(".py")) return true;
  return false;
}

/** Where one file's absolute imports are searched, in order. */
function searchRoots(ctx: Context, roots: string[], here: string): string[] {
  const isPackage = exists(ctx, [`${here ? `${here}/` : ""}__init__.py`, `${here ? `${here}/` : ""}__init__.pyi`]) !== null;
  return isPackage || roots.includes(here) ? roots : [here, ...roots];
}

/** The first root holding top-level module `top`, other than the importer itself. */
function rootFor(ctx: Context, roots: string[], from: string, top: string): string | undefined {
  return roots.find((r) => {
    const hit = exists(ctx, candidates(r, top));
    return hit !== null && hit !== from;
  });
}

function moduleName(path: string, roots: string[]): string | null {
  for (const root of roots) {
    const prefix = root ? `${root}/` : "";
    if (root && !path.startsWith(prefix)) continue;
    const inner = path.slice(prefix.length).replace(/\.pyi?$/, "");
    const parts = inner.split("/");
    if (parts.at(-1) === "__init__") parts.pop();
    if (parts.length && parts.every((p) => /^[A-Za-z_]\w*$/.test(p))) return parts.join(".");
  }
  return null;
}

/** The files that could be module `dir/a/b`: a module file or a package. */
function candidates(dir: string, dotted: string): string[] {
  const base = relJoin(dir, ...dotted.split("."));
  if (base === null) return [];
  return [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`].map((p) => p.replace(/^\//, ""));
}

function exists(ctx: Context, paths: string[]): string | null {
  return paths.find((p) => ctx.files.has(p)) ?? null;
}

export const python: LanguageHandler = {
  languages: ["python"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("python");
    const projects = projectDirs(ctx);
    // Whether a project has a src/ layout depends only on the project, and
    // finding out scans every path, so it's decided once per project.
    const srcDirs = new Set(projects.map((d) => (d ? `${d}/src` : "src")).filter((src) => isDirWithPython(ctx, src)));
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      const { search: roots, naming } = rootsFor(projects, srcDirs, file.path);
      file.module = moduleName(file.path, naming);
      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      const here = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);

      for (const node of tree.rootNode.descendantsOfType("import_statement")) {
        for (const name of node.childrenForFieldName("name")) {
          const dotted = (name.type === "aliased_import" ? name.childForFieldName("name") : name)?.text;
          if (dotted) out.push(absolute(ctx, searchRoots(ctx, roots, here), file.path, dotted, lineOf(node)));
        }
      }

      for (const node of tree.rootNode.descendantsOfType("import_from_statement")) {
        const moduleNode = node.childForFieldName("module_name");
        if (!moduleNode) continue;
        const line = lineOf(node);
        const names = node.childrenForFieldName("name").map((n: SyntaxNode) =>
          (n.type === "aliased_import" ? n.childForFieldName("name") : n)?.text ?? "");

        if (moduleNode.type === "relative_import") {
          const dots = moduleNode.descendantsOfType("import_prefix")[0]?.text.length ?? 1;
          const rest = moduleNode.namedChildren.find((c: SyntaxNode) => c.type === "dotted_name")?.text ?? "";
          const base = relJoin(here, ...Array(dots - 1).fill(".."));
          if (base === null) {
            out.push(record.unresolved(file.path, moduleNode.text, "import", line, "relative import climbs above the repository root"));
            continue;
          }
          out.push(...fromImport(ctx, file.path, moduleNode.text, base, rest, names, line));
        } else {
          const dotted = moduleNode.text;
          const root = rootFor(ctx, searchRoots(ctx, roots, here), file.path, dotted.split(".")[0]);
          if (root === undefined) {
            out.push(record.external(file.path, dotted, "import", line, "not a module in this repository (standard library or installed package)"));
            continue;
          }
          const parts = dotted.split(".");
          const base = relJoin(root, ...parts.slice(0, -1));
          out.push(...fromImport(ctx, file.path, dotted, base ?? root, parts.at(-1) ?? "", names, line));
        }
      }
      tree.delete();
    }
    parser.delete();
    return out;
  },
};

function absolute(ctx: Context, roots: string[], from: string, dotted: string, line: number): ImportRecord {
  const top = dotted.split(".")[0];
  const root = rootFor(ctx, roots, from, top);
  if (root === undefined) {
    return record.external(from, dotted, "import", line, "not a module in this repository (standard library or installed package)");
  }
  return verdict(ctx, from, dotted, "import", line, candidates(root, dotted),
    `package "${top}" is in the repository but has no module "${dotted}"`);
}

/**
 * `from <base>.<mod> import a, b`. Each name may be a submodule (its own file)
 * or something defined in the module itself; the file that exists decides.
 */
function fromImport(
  ctx: Context, from: string, written: string, base: string, mod: string, names: string[], line: number,
): ImportRecord[] {
  const moduleFiles = mod ? candidates(base, mod) : [`${base ? `${base}/` : ""}__init__.py`, `${base ? `${base}/` : ""}__init__.pyi`];
  const moduleDir = mod ? relJoin(base, ...mod.split(".")) : base;
  const out: ImportRecord[] = [];
  const pending: string[] = [];
  for (const name of names) {
    if (!name) continue;
    const sub = moduleDir !== null ? exists(ctx, candidates(moduleDir, name)) : null;
    if (sub) out.push(record.resolved(from, `${written}.${name}`, "import", line, [sub]));
    else pending.push(name);
  }
  // Wildcards and names defined in the module itself point at the module file.
  if (pending.length > 0 || names.length === 0 || names.every((n) => !n)) {
    out.push(verdict(ctx, from, written, "import", line, moduleFiles,
      mod ? `no module "${written}" in the repository` : `no __init__.py in ${base || "the repository root"}`));
  }
  return out;
}
