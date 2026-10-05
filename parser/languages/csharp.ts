import { record } from "../context.ts";
import type { LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// A plain `using A.B;` opens a namespace, which spreads across many files, so
// it can't honestly be one edge and is recorded as excluded. `using static
// A.B.C;` and `using X = A.B.C;` name a type, and the files declaring that type
// (several, for a partial class) are the edges.
//
// The grammar available predates C# 10, so a file-scoped `namespace X;` is a
// syntax error to it and the types in that file can't be indexed.

const TYPE_DECLS = new Set([
  "class_declaration", "struct_declaration", "interface_declaration",
  "enum_declaration", "record_declaration", "delegate_declaration",
]);

function qualifiedName(node: SyntaxNode | null | undefined): string | null {
  return node && (node.type === "qualified_name" || node.type === "identifier") ? node.text : null;
}

/**
 * A name the readable files don't declare. With every file readable it's
 * outside the repository; otherwise it might be declared in a file the grammar
 * couldn't read, so it's unresolved rather than guessed external.
 */
function unknown(from: string, written: string, line: number, unreadable: number): ImportRecord {
  return unreadable === 0
    ? record.external(from, written, "import", line, "not declared in this repository (framework or a package)")
    : record.unresolved(from, written, "import", line,
        `not declared in any readable C# file; ${unreadable} file(s) couldn't be fully read (file-scoped namespaces are the usual cause)`);
}

export const csharp: LanguageHandler = {
  languages: ["csharp"],

  async analyze(sources: Source[]): Promise<ImportRecord[]> {
    const parser = await parserFor("c_sharp");
    const types = new Map<string, Set<string>>();
    const namespaces = new Set<string>();
    let unreadable = 0;
    const parsed: { source: Source; usings: SyntaxNode[] }[] = [];
    const trees = [];

    for (const source of sources) {
      const tree = parser.parse(source.text);
      trees.push(tree);
      source.file.hadSyntaxErrors = tree.rootNode.hasError;
      if (tree.rootNode.hasError) unreadable++;

      const visit = (node: SyntaxNode, ns: string) => {
        for (const child of node.namedChildren) {
          if (child.type === "namespace_declaration") {
            const name = qualifiedName(child.childForFieldName("name")) ?? "";
            const full = [ns, name].filter(Boolean).join(".");
            namespaces.add(full);
            const body = child.childForFieldName("body");
            if (body) visit(body, full);
          } else if (TYPE_DECLS.has(child.type)) {
            const name = child.childForFieldName("name")?.text;
            if (!name) continue;
            const full = [ns, name].filter(Boolean).join(".");
            const set = types.get(full) ?? new Set<string>();
            set.add(source.file.path);
            types.set(full, set);
          }
        }
      };
      visit(tree.rootNode, "");
      parsed.push({ source, usings: tree.rootNode.descendantsOfType("using_directive") });
    }

    const out: ImportRecord[] = [];
    for (const { source, usings } of parsed) {
      const from = source.file.path;
      for (const node of usings) {
        const target = node.namedChildren.filter((c: SyntaxNode) => c.type === "qualified_name" || c.type === "identifier").at(-1)?.text;
        if (!target) continue;
        const line = lineOf(node);
        const isStatic = node.children.some((c: SyntaxNode) => c.type === "static");
        const isAlias = node.namedChildren.some((c: SyntaxNode) => c.type === "name_equals");
        const written = node.text.replace(/;\s*$/, "");

        const declaring = types.get(target);
        if (declaring && (isStatic || isAlias)) {
          out.push(record.resolved(from, written, "import", line, [...declaring].sort()));
        } else if (namespaces.has(target)) {
          out.push(record.excluded(from, written, "import", line, "opens a namespace, which spans files; no single file to point at"));
        } else if ((isStatic || isAlias) && namespaces.has(target.split(".").slice(0, -1).join("."))) {
          out.push(record.unresolved(from, written, "import", line, `namespace is in the repository, but no file declares type ${target}`));
        } else {
          out.push(unknown(from, written, line, unreadable));
        }
      }
    }
    for (const t of trees) t.delete();
    parser.delete();
    return out;
  },
};
