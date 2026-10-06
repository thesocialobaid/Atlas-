import { dirname, join } from "node:path";
import type Parser from "web-tree-sitter";

// One parsing engine for every language except JS/TS, loading each grammar on
// first use. The grammars are prebuilt for tree-sitter 0.20, which is why
// web-tree-sitter is pinned to 0.22: newer engines reject them.

export type SyntaxNode = Parser.SyntaxNode;

// The engine and its grammars are loaded by Node at runtime, never through a
// bundler. Inside the Next server, Turbopack wraps CommonJS packages and
// rewrites require.resolve() into stand-ins: web-tree-sitter's class came
// back without its static init(), and the grammar folder as a module id
// rather than a path on disk. Node's own createRequire, fetched through
// process.getBuiltinModule, is invisible to it, so both behave exactly as
// they do from a plain script.
let nodeRequire: NodeJS.Require | null = null;
function requireFromHere(): NodeJS.Require {
  nodeRequire ??= process.getBuiltinModule("node:module").createRequire(import.meta.url);
  return nodeRequire;
}

/**
 * The engine, held once per process. web-tree-sitter is compiled by
 * Emscripten, and its init() overwrites the package's own module.exports with
 * Emscripten's runtime object. Anything that requires the package after that
 * gets the runtime, not the Parser class. A script loads it once and exits; a
 * long-lived server reloads modules (and a reloaded copy of this one would
 * require it again), so the class is captured before init() ever runs and kept
 * on globalThis, together with the one init() and the grammars it loaded.
 */
type EngineState = {
  Engine: typeof Parser;
  ready: Promise<void>;
  languages: Map<string, Promise<Parser.Language>>;
};

declare global {
  var atlasTreeSitter: EngineState | undefined;
}

function engineState(): EngineState {
  if (globalThis.atlasTreeSitter) return globalThis.atlasTreeSitter;
  const loaded: unknown = requireFromHere()("web-tree-sitter");
  // Language is attached by init(), so only init() can be checked here.
  if (typeof loaded !== "function" || !("init" in loaded) || typeof loaded.init !== "function") {
    const keys = typeof loaded === "object" || typeof loaded === "function" ? Object.keys(loaded ?? {}).slice(0, 8).join(", ") : "";
    throw new Error(
      `web-tree-sitter loaded without its Parser class: expected a class with a static init(), got a ${typeof loaded}${keys ? ` with ${keys}` : ""}. If this process loaded it before, restart it.`,
    );
  }
  // A module loader returns an untyped value; this is the one place it's given
  // the package's type, and only after checking it has that shape.
  const Engine = loaded as typeof Parser;
  globalThis.atlasTreeSitter = { Engine, ready: Engine.init(), languages: new Map() };
  return globalThis.atlasTreeSitter;
}

let grammars: string | null = null;
function grammarDir(): string {
  grammars ??= join(dirname(requireFromHere().resolve("tree-sitter-wasms/package.json")), "out");
  return grammars;
}

export async function parserFor(grammar: string): Promise<Parser> {
  const { Engine, ready, languages } = engineState();
  await ready;
  let language = languages.get(grammar);
  if (!language) {
    language = Engine.Language.load(join(grammarDir(), `tree-sitter-${grammar}.wasm`));
    languages.set(grammar, language);
  }
  const parser = new Engine();
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
