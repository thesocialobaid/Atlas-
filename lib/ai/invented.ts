// The invented-path check: every path-shaped token in an explanation, tested
// against the exact set of paths the model was shown. Set membership has an
// exact answer, so this is code, never a model grading a model.
//
// Pure: no imports, no I/O. The app runs it on every fresh explanation and the
// evals run the same function, so there's one definition of "invented".

/**
 * File extensions that make a token path-shaped: the ones the parser names,
 * plus the template and script types of the frameworks it has adapters for.
 * A token like `process.env` or `res.json` ends in something that isn't one.
 */
const EXTENSIONS = [
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs", "java", "cs",
  "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "css", "scss", "sass", "less", "html", "htm",
  "md", "mdx", "json", "jsonc", "yml", "yaml", "toml", "xml", "sh", "bash", "ps1", "rb", "php",
  "kt", "kts", "swift", "scala", "vue", "svelte", "astro", "sql", "lua", "dart", "erb", "ex", "exs",
  "heex", "eex", "twig", "cshtml", "razor", "csproj", "sln", "gradle", "rake", "txt",
];

// Characters a path segment may hold, including Next's (group) and [param]
// folders. A token may not start right after another path character, so a
// URL's path (after "//") never starts a match of its own; one followed by
// "(" is a call like `res.json()`.
const SEGMENT = String.raw`[\w\-.@+~$()\[\]{}]`;
const TOKEN = new RegExp(
  String.raw`(?<![\w/.\-@])((?:${SEGMENT}+/)*${SEGMENT}+\.(?:${EXTENSIONS.join("|")}))(?![\w/\-(])`,
  "gi",
);

const CODE_SPAN = /`([^`\n]+)`/g;

/** A bracket the token picked up from the sentence around it, not from the path. */
function trimmed(token: string): string {
  let t = token;
  const count = (s: string, ch: string) => s.split(ch).length - 1;
  while ((t.startsWith("(") && count(t, "(") > count(t, ")")) || (t.startsWith("[") && count(t, "[") > count(t, "]"))) t = t.slice(1);
  while ((t.endsWith(")") && count(t, ")") > count(t, "(")) || (t.endsWith("]") && count(t, "]") > count(t, "["))) t = t.slice(0, -1);
  return t;
}

/**
 * Path-shaped tokens, in order of first appearance. A token with a folder in
 * it, or written as inline code, counts wherever it's written. A bare
 * filename in prose counts unless it's capitalised: models write root files
 * like app.js in plain text, while "Next.js" and "Node.js" are names, not
 * files. A capitalised root file in prose (App.js) is missed, and a
 * lowercase name in prose ("node.js") is flagged; the first only misses an
 * invention, the second is plain to see on the trace.
 *
 * Known gap: a path written without its extension isn't checked.
 */
export function pathTokens(text: string): string[] {
  const found = new Set<string>();
  const take = (chunk: string, inCode: boolean) => {
    for (const m of chunk.matchAll(TOKEN)) {
      const t = trimmed(m[1]);
      if (inCode || t.includes("/") || !/^[A-Z]/.test(t)) found.add(t);
    }
  };
  take(text.replace(CODE_SPAN, " "), false);
  for (const m of text.matchAll(CODE_SPAN)) take(m[1], true);
  return [...found];
}

/**
 * Whether a token names a shown path. Exact match, or the token is a shown
 * path with leading folders left off (`cache.ts`, `ai/cache.ts`, or a relative
 * `../ai/cache.ts` copied from the source for `lib/ai/cache.ts`): a shortened
 * name for a file the model was shown, not a file it made up.
 */
function grounded(token: string, shown: ReadonlySet<string>, suffixes: ReadonlySet<string>): boolean {
  if (shown.has(token)) return true;
  const bare = token.replace(/^(?:\.{1,2}\/)+/, "");
  return shown.has(bare) || suffixes.has(bare);
}

export type PathCheck = {
  /** Every path-shaped token in the explanation. */
  mentioned: string[];
  /** The ones that aren't a path the model was shown. */
  invented: string[];
};

export function checkPaths(body: string, shownPaths: readonly string[]): PathCheck {
  const shown = new Set(shownPaths);
  const suffixes = new Set<string>();
  for (const p of shown) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) suffixes.add(parts.slice(i).join("/"));
  }
  const mentioned = pathTokens(body);
  return { mentioned, invented: mentioned.filter((t) => !grounded(t, shown, suffixes)) };
}

/** The feedback recorded for one explanation: 1 when nothing was invented, 0 otherwise. */
export const INVENTED_PATHS_KEY = "no_invented_paths";
