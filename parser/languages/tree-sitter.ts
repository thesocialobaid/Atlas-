import { dirname, join } from "node:path";
import Parser from "web-tree-sitter";

// One parsing engine for every language except JS/TS, loading each grammar on
// first use. The grammars are prebuilt for tree-sitter 0.20, which is why
// web-tree-sitter is pinned to 0.22: newer engines reject them.

export type SyntaxNode = Parser.SyntaxNode;

// The grammar folder is found by Node at runtime, never by a bundler. Inside
// the Next server, Turbopack replaces both require.resolve("...") and the
// require that createRequire(import.meta.url) returns with its own stand-ins,
// which hand back a module id rather than a folder on disk. Node's own
// createRequire, fetched through process.getBuiltinModule, is invisible to it.
let grammars: string | null = null;
function grammarDir(): string {
  if (grammars === null) {
    const { createRequire: nodeCreateRequire } = process.getBuiltinModule("node:module");
    const resolve = nodeCreateRequire(import.meta.url).resolve;
    grammars = join(dirname(resolve("tree-sitter-wasms/package.json")), "out");
  }
  return grammars;
}

let ready: Promise<void> | null = null;
const loaded = new Map<string, Promise<Parser.Language>>();

export async function parserFor(grammar: string): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let language = loaded.get(grammar);
  if (!language) {
    language = Parser.Language.load(join(grammarDir(), `tree-sitter-${grammar}.wasm`));
    loaded.set(grammar, language);
  }
  const parser = new Parser();
  parser.setLanguage(await language);
  return parser;
}

export function lineOf(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

/** The text inside a string literal node, without its quotes. */
export function unquote(text: string): string {
  return text.replace(/^["'`]|["'`]$/g, "");
}
