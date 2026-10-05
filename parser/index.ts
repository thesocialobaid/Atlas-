import { resolve } from "node:path";
import { pickAdapter } from "./adapter.ts";
import type { Adapter } from "./adapter.ts";
import type { Context, LanguageHandler, Source } from "./context.ts";
import { coverageOf } from "./coverage.ts";
import { listFiles, loadFile } from "./files.ts";
import { edgesFrom, fanCounts } from "./graph.ts";
import { c } from "./languages/c.ts";
import { csharp } from "./languages/csharp.ts";
import { go } from "./languages/go.ts";
import { java } from "./languages/java.ts";
import { javascript } from "./languages/javascript.ts";
import { python } from "./languages/python.ts";
import { rust } from "./languages/rust.ts";
import { css, html } from "./languages/web.ts";
import { OUTPUT_VERSION } from "./types.ts";
import type { ParseResult } from "./types.ts";

export type { ParseResult } from "./types.ts";

// Adding a language means adding a handler here; nothing else changes.
const HANDLERS: LanguageHandler[] = [javascript, python, go, rust, java, csharp, c, css, html];

// Framework adapters arrive in later phases; until then the fallback applies.
const ADAPTERS: Adapter[] = [];

/**
 * Directory in, data out. Fetches nothing and starts nothing: how the
 * repository got onto disk is the caller's business.
 */
export async function parseRepository(directory: string): Promise<ParseResult> {
  const root = resolve(directory);
  const byLanguage = new Map<string, LanguageHandler>();
  for (const h of HANDLERS) for (const l of h.languages) byLanguage.set(l, h);

  const { paths, source } = listFiles(root);
  const ctx: Context = { root, files: new Map(), text: new Map() };
  for (const path of paths) {
    const { file, text } = loadFile(root, path, (language) => byLanguage.has(language));
    ctx.files.set(path, file);
    if (text !== null) ctx.text.set(path, text);
  }

  const imports = [];
  for (const handler of HANDLERS) {
    const sources: Source[] = [];
    for (const [path, text] of ctx.text) {
      const file = ctx.files.get(path);
      if (file && handler.languages.includes(file.language)) sources.push({ file, text });
    }
    if (sources.length > 0) imports.push(...(await handler.analyze(sources, ctx)));
  }

  const files = [...ctx.files.values()];
  const adapter = pickAdapter(ADAPTERS, files);
  for (const f of files) f.role = adapter.roleOf(f);

  const edges = edgesFrom(imports);
  return {
    version: OUTPUT_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    fileSource: source,
    adapter: adapter.name,
    files,
    imports,
    edges,
    fan: fanCounts(files.map((f) => f.path), edges),
    coverage: coverageOf(files, imports),
  };
}
