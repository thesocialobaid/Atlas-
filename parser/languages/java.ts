import { posix } from "node:path";
import { record } from "../context.ts";
import type { LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// A Java import names a class by package and class name; the file is the one
// that declares that package and is named after that class. Every file is read
// for its package before any import is resolved.

export const java: LanguageHandler = {
  languages: ["java"],

  async analyze(sources: Source[]): Promise<ImportRecord[]> {
    const parser = await parserFor("java");
    const classes = new Map<string, string>();
    const packages = new Set<string>();
    const parsed: { source: Source; imports: SyntaxNode[] }[] = [];
    const trees = [];

    for (const source of sources) {
      const tree = parser.parse(source.text);
      trees.push(tree);
      source.file.hadSyntaxErrors = tree.rootNode.hasError;
      const decl = tree.rootNode.namedChildren.find((n: SyntaxNode) => n.type === "package_declaration");
      const pkg = decl?.namedChildren.find((n: SyntaxNode) => n.type === "scoped_identifier" || n.type === "identifier")?.text ?? "";
      const fqcn = [pkg, posix.basename(source.file.path, ".java")].filter(Boolean).join(".");
      source.file.module = fqcn;
      classes.set(fqcn, source.file.path);
      if (pkg) packages.add(pkg);
      parsed.push({ source, imports: tree.rootNode.descendantsOfType("import_declaration") });
    }

    const out: ImportRecord[] = [];
    for (const { source, imports } of parsed) {
      const from = source.file.path;
      for (const node of imports) {
        const name = node.namedChildren.find((n: SyntaxNode) => n.type === "scoped_identifier" || n.type === "identifier")?.text;
        if (!name) continue;
        const line = lineOf(node);
        const isStatic = node.children.some((c: SyntaxNode) => c.type === "static");
        const wildcard = node.children.some((c: SyntaxNode) => c.type === "asterisk");
        const written = `${isStatic ? "static " : ""}${name}${wildcard ? ".*" : ""}`;

        if (wildcard && !isStatic) {
          out.push(packages.has(name)
            ? record.excluded(from, written, "import", line, "wildcard import names a whole package, not a file")
            : record.external(from, written, "import", line, "not a package in this repository (JDK or a dependency)"));
          continue;
        }

        // A static import names a member; an import may name a nested class.
        // Either way the file is the longest prefix that is a declared class.
        const parts = name.split(".");
        let hit: string | null = null;
        for (let n = parts.length - (isStatic && !wildcard ? 1 : 0); n >= 2 && !hit; n--) {
          hit = classes.get(parts.slice(0, n).join(".")) ?? null;
        }
        if (hit) {
          out.push(record.resolved(from, written, "import", line, [hit]));
          continue;
        }
        const knownPackage = parts.some((_, i) => packages.has(parts.slice(0, i + 1).join(".")));
        out.push(knownPackage
          ? record.unresolved(from, written, "import", line, "its package is in the repository, but no file declares that class")
          : record.external(from, written, "import", line, "not a package in this repository (JDK or a dependency)"));
      }
    }
    for (const t of trees) t.delete();
    parser.delete();
    return out;
  },
};
