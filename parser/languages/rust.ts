import { posix } from "node:path";
import { record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor } from "./tree-sitter.ts";

// `mod foo;` is how Rust stitches files together, so it's the edge. `use`
// paths name items inside the crate's module tree, not files; following them
// needs the whole tree built first, which this phase doesn't do. They're
// recorded as excluded so the gap is visible.

/**
 * Crate roots and mod.rs keep their child modules beside them; any other file
 * keeps them in a folder named after itself. Crate roots are where Cargo looks
 * for them: lib.rs, main.rs, build.rs, and files directly in bin/, tests/,
 * examples/ and benches/.
 */
function ownsItsDirectory(path: string): boolean {
  const base = posix.basename(path);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs" || base === "build.rs") return true;
  const parent = posix.basename(posix.dirname(path));
  return parent === "bin" || parent === "tests" || parent === "examples" || parent === "benches";
}

export const rust: LanguageHandler = {
  languages: ["rust"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("rust");
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      const dir = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);
      const childDir = ownsItsDirectory(file.path)
        ? dir
        : relJoin(dir, posix.basename(file.path, ".rs")) ?? dir;

      for (const item of tree.rootNode.descendantsOfType("mod_item")) {
        if (item.childForFieldName("body")) continue; // inline module, no file
        const name = item.childForFieldName("name")?.text;
        if (!name) continue;
        const line = lineOf(item);
        // Inside `mod a { mod b; }` the file is a/b.rs, so walk up the inline modules.
        const nesting: string[] = [];
        for (let p = item.parent; p; p = p.parent) {
          if (p.type === "mod_item") nesting.unshift(p.childForFieldName("name")?.text ?? "");
        }
        const where = relJoin(childDir, ...nesting) ?? childDir;
        const previous = item.previousNamedSibling;
        if (previous?.type === "attribute_item" && /^#\[\s*path\b/.test(previous.text)) {
          out.push(record.unresolved(file.path, name, "module-declaration", line,
            "#[path] attribute overrides the file location; not followed yet"));
          continue;
        }
        out.push(verdict(ctx, file.path, name, "module-declaration", line,
          [relJoin(where, `${name}.rs`), relJoin(where, name, "mod.rs")].filter((p): p is string => p !== null),
          `no ${name}.rs or ${name}/mod.rs in ${where || "the repository root"}`));
      }

      for (const use of tree.rootNode.descendantsOfType("use_declaration")) {
        const arg = use.childForFieldName("argument");
        out.push(record.excluded(file.path, arg?.text ?? use.text, "import", lineOf(use),
          "Rust `use` names an item in the module tree, not a file; only `mod` declarations are followed"));
      }
      tree.delete();
    }
    parser.delete();
    return out;
  },
};
