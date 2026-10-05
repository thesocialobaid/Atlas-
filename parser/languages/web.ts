import { posix } from "node:path";
import { judgePath, record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportKind, ImportRecord } from "../types.ts";
import { lineOf, parserFor, unquote } from "./tree-sitter.ts";
import type { SyntaxNode } from "./tree-sitter.ts";

// CSS @import and HTML script/link references are URLs relative to the file
// that holds them. A root-relative URL ("/main.js") depends on which folder
// the server treats as its root, which the repository doesn't state.

function resolveUrl(ctx: Context, from: string, url: string, kind: ImportKind, line: number): ImportRecord {
  const clean = url.split(/[?#]/)[0];
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return record.external(from, url, kind, line, "absolute URL");
  }
  if (clean.startsWith("~")) {
    return record.external(from, url, kind, line, "package path (~ resolves into installed packages)");
  }
  if (clean.startsWith("/")) {
    return record.unresolved(from, url, kind, line, "root-relative URL; which folder the server serves as its root isn't stated in the repository");
  }
  const dir = posix.dirname(from) === "." ? "" : posix.dirname(from);
  const candidate = relJoin(dir, clean);
  if (candidate === null) return record.unresolved(from, url, kind, line, "path climbs above the repository root");
  // A bare CSS @import ("tailwindcss") is tried beside the file first, then
  // from installed packages, which is how postcss-import and Vite resolve it.
  const bare = kind === "import" && !clean.startsWith("./") && !clean.startsWith("../");
  if (bare && judgePath(ctx, candidate) === "missing") {
    return record.external(from, url, kind, line, "bare @import with no file beside it: an installed package");
  }
  return verdict(ctx, from, url, kind, line, [candidate], `no file at ${candidate}`);
}

export const css: LanguageHandler = {
  languages: ["css"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("css");
    const out: ImportRecord[] = [];
    for (const { file, text } of sources) {
      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      for (const stmt of tree.rootNode.descendantsOfType("import_statement")) {
        const target = stmt.namedChildren[0];
        let url: string | null = null;
        if (target?.type === "string_value") url = unquote(target.text);
        else if (target?.type === "call_expression") {
          const arg = target.descendantsOfType(["string_value", "plain_value"])[0];
          if (arg) url = unquote(arg.text);
        }
        if (url === null) {
          out.push(record.excluded(file.path, stmt.text, "import", lineOf(stmt), "@import without a literal URL"));
          continue;
        }
        out.push(resolveUrl(ctx, file.path, url, "import", lineOf(stmt)));
      }
      tree.delete();
    }
    parser.delete();
    return out;
  },
};

function attribute(startTag: SyntaxNode, name: string): string | null {
  for (const attr of startTag.descendantsOfType("attribute")) {
    const attrName = attr.descendantsOfType("attribute_name")[0]?.text.toLowerCase();
    if (attrName !== name) continue;
    const value = attr.descendantsOfType("attribute_value")[0];
    return value ? value.text : null;
  }
  return null;
}

export const html: LanguageHandler = {
  languages: ["html"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parser = await parserFor("html");
    const out: ImportRecord[] = [];
    for (const { file, text } of sources) {
      const tree = parser.parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      for (const tag of tree.rootNode.descendantsOfType("start_tag")) {
        const tagName = tag.descendantsOfType("tag_name")[0]?.text.toLowerCase();
        const url = tagName === "script" ? attribute(tag, "src") : tagName === "link" ? attribute(tag, "href") : null;
        if (url) out.push(resolveUrl(ctx, file.path, url, "reference", lineOf(tag)));
      }
      tree.delete();
    }
    parser.delete();
    return out;
  },
};
