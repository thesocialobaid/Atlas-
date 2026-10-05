import { posix } from "node:path";
import { readNode, record } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor, unquote } from "./tree-sitter.ts";

// A Go import names a package, which is a directory. The edge goes to every
// non-test .go file in that directory, because together they are the package.
// Import paths map onto directories through each go.mod's module line.

type GoModule = { path: string; dir: string };

function modules(ctx: Context): GoModule[] {
  const out: GoModule[] = [];
  for (const p of ctx.files.keys()) {
    if (p !== "go.mod" && !p.endsWith("/go.mod")) continue;
    const text = readNode(ctx, p);
    // The module directive is a single line by the go.mod grammar.
    const match = text?.match(/^module\s+"?([^\s"]+)"?/m);
    if (match) out.push({ path: match[1], dir: posix.dirname(p) === "." ? "" : posix.dirname(p) });
  }
  // Longest module path first, so a nested module wins over its parent.
  return out.sort((a, b) => b.path.length - a.path.length);
}

function packageFiles(ctx: Context, dir: string): string[] {
  const prefix = dir ? `${dir}/` : "";
  const files: string[] = [];
  for (const p of ctx.files.keys()) {
    if (!p.startsWith(prefix) || !p.endsWith(".go") || p.endsWith("_test.go")) continue;
    if (!p.slice(prefix.length).includes("/")) files.push(p);
  }
  return files;
}

export const go: LanguageHandler = {
  languages: ["go"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("go");
    const mods = modules(ctx);
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      const dir = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);
      const own = mods.find((m) => m.dir === "" || dir === m.dir || dir.startsWith(`${m.dir}/`));
      file.module = own ? [own.path, dir.slice(own.dir.length).replace(/^\//, "")].filter(Boolean).join("/") : null;

      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      for (const spec of tree.rootNode.descendantsOfType("import_spec")) {
        const pathNode = spec.childForFieldName("path");
        if (!pathNode) continue;
        const importPath = unquote(pathNode.text);
        const line = lineOf(spec);
        if (importPath === "C") {
          out.push(record.excluded(file.path, importPath, "import", line, "cgo pseudo-package, not a directory"));
          continue;
        }

        const mod = mods.find((m) => importPath === m.path || importPath.startsWith(`${m.path}/`));
        let target: string | null = null;
        if (mod) {
          target = [mod.dir, importPath.slice(mod.path.length).replace(/^\//, "")].filter(Boolean).join("/");
        } else if (own) {
          // A vendored dependency is a copy inside the repository.
          const vendored = [own.dir, "vendor", importPath].filter(Boolean).join("/");
          if (packageFiles(ctx, vendored).length > 0) target = vendored;
        }

        if (target === null) {
          out.push(record.external(file.path, importPath, "import", line,
            mods.length ? "standard library or another module" : "no go.mod in the repository to map import paths onto directories"));
          continue;
        }
        const files = packageFiles(ctx, target);
        out.push(files.length > 0
          ? record.resolved(file.path, importPath, "import", line, files)
          : record.unresolved(file.path, importPath, "import", line, `package directory ${target || "."} has no non-test Go files in the repository`));
      }
      tree.delete();
    }
    parser.delete();
    return out;
  },
};
