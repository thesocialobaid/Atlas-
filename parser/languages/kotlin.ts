import { record } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// A Kotlin import names something declared at the top of a file in some
// package: a class, an object, a function, a property, a type alias. Unlike
// Java, the file needn't be named after it, and one file can declare many, so
// every file is read for its package and its top-level names before any
// import is resolved. A name declared in several files (overloads of a
// top-level function) resolves to all of them. Java classes in the same
// repository are found by the name the Java handler gave them.

const DECLARATIONS = new Set(["class_declaration", "object_declaration", "function_declaration", "property_declaration", "type_alias"]);

/** The name a top-level declaration introduces. */
function declaredName(node: SyntaxNode): string | null {
  if (node.type === "class_declaration" || node.type === "object_declaration" || node.type === "type_alias") {
    return node.namedChildren.find((c) => c.type === "type_identifier")?.text ?? null;
  }
  if (node.type === "function_declaration") {
    // An extension function's receiver type comes first; its name is the identifier after.
    return node.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  }
  if (node.type === "property_declaration") {
    return node.namedChildren.find((c) => c.type === "variable_declaration")?.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
  }
  return null;
}

export const kotlin: LanguageHandler = {
  languages: ["kotlin"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("kotlin");
    const declared = new Map<string, string[]>();
    const packages = new Set<string>();
    const parsed: { source: Source; imports: SyntaxNode[] }[] = [];
    const trees = [];

    for (const source of sources) {
      const tree = parser.parse(source.text);
      trees.push(tree);
      source.file.hadSyntaxErrors = tree.rootNode.hasError;
      const pkg = tree.rootNode.namedChildren.find((n) => n.type === "package_header")?.namedChildren.find((n) => n.type === "identifier")?.text ?? "";
      if (pkg) packages.add(pkg);
      source.file.module = pkg || null;
      for (const node of tree.rootNode.namedChildren) {
        if (!DECLARATIONS.has(node.type)) continue;
        const name = declaredName(node);
        if (!name) continue;
        const fq = pkg ? `${pkg}.${name}` : name;
        const files = declared.get(fq) ?? [];
        if (!files.includes(source.file.path)) files.push(source.file.path);
        declared.set(fq, files);
      }
      parsed.push({ source, imports: tree.rootNode.descendantsOfType("import_header") });
    }

    // Java classes in the same repository, by the qualified name the Java handler recorded.
    for (const f of ctx.files.values()) {
      if (f.language !== "java" || !f.module) continue;
      declared.set(f.module, [f.path]);
      const dot = f.module.lastIndexOf(".");
      if (dot > 0) packages.add(f.module.slice(0, dot));
    }

    const out: ImportRecord[] = [];
    for (const { source, imports } of parsed) {
      const from = source.file.path;
      for (const node of imports) {
        const name = node.namedChildren.find((n) => n.type === "identifier")?.text;
        if (!name) continue;
        const line = lineOf(node);
        const wildcard = node.namedChildren.some((c) => c.type === "wildcard_import");
        const written = wildcard ? `${name}.*` : name;

        if (wildcard) {
          out.push(packages.has(name)
            ? record.excluded(from, written, "import", line, "wildcard import names a whole package, not a file")
            : record.external(from, written, "import", line, "not a package in this repository (the standard library or a dependency)"));
          continue;
        }

        // An import may name a nested class or an object's member: the file
        // is the longest prefix that something declares.
        const parts = name.split(".");
        let hit: string[] | null = null;
        for (let n = parts.length; n >= 1 && !hit; n--) hit = declared.get(parts.slice(0, n).join(".")) ?? null;
        if (hit) {
          out.push(record.resolved(from, written, "import", line, hit));
          continue;
        }
        const knownPackage = parts.some((_, i) => packages.has(parts.slice(0, i + 1).join(".")));
        out.push(knownPackage
          ? record.unresolved(from, written, "import", line, "its package is in the repository, but no readable file declares that name")
          : record.external(from, written, "import", line, "not a package in this repository (the standard library or a dependency)"));
      }
    }
    for (const t of trees) t.delete();
    parser.delete();
    return out;
  },
};
