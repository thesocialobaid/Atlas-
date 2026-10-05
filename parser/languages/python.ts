import { posix } from "node:path";
import { record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// Absolute imports are looked up from the repository root, and from src/ when
// it exists: the two layouts Python packaging documents. A name found in
// neither is outside the repository (standard library or an installed package).

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
    const roots = [""];
    for (const p of ctx.files.keys()) if (p.startsWith("src/") && p.endsWith(".py")) { roots.push("src"); break; }
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      file.module = moduleName(file.path, [...roots].reverse());
      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      const here = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);

      for (const node of tree.rootNode.descendantsOfType("import_statement")) {
        for (const name of node.childrenForFieldName("name")) {
          const dotted = (name.type === "aliased_import" ? name.childForFieldName("name") : name)?.text;
          if (dotted) out.push(absolute(ctx, roots, file.path, dotted, lineOf(node)));
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
          const root = roots.find((r) => exists(ctx, candidates(r, dotted.split(".")[0])) !== null);
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
  const root = roots.find((r) => exists(ctx, candidates(r, top)) !== null);
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
