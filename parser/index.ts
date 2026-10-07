import { resolve } from "node:path";
import { applyAdapters } from "./adapter.ts";
import type { AdapterInput } from "./adapter.ts";
import { ADAPTERS } from "./adapters/index.ts";
import { readNode } from "./context.ts";
import type { Context, LanguageHandler, Source } from "./context.ts";
import { coverageOf } from "./coverage.ts";
import { listFiles, loadFile } from "./files.ts";
import { edgesFrom, fanCounts } from "./graph.ts";
import { c } from "./languages/c.ts";
import { csharp } from "./languages/csharp.ts";
import { go } from "./languages/go.ts";
import { java } from "./languages/java.ts";
import { kotlin } from "./languages/kotlin.ts";
import { javascript } from "./languages/javascript.ts";
import { python } from "./languages/python.ts";
import { rust } from "./languages/rust.ts";
import { css, html } from "./languages/web.ts";
import { OUTPUT_VERSION } from "./types.ts";
import type { ParseResult } from "./types.ts";

export type { ParseResult } from "./types.ts";

// Adding a language means adding a handler here; nothing else changes.
// Kotlin comes after Java: it resolves imports of Java classes by the names Java recorded.
const HANDLERS: LanguageHandler[] = [javascript, python, go, rust, java, kotlin, csharp, c, css, html];

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
  const input: AdapterInput = { files, read: (path) => readNode(ctx, path), imports };
  const framework = await applyAdapters(ADAPTERS, input);
  for (const f of files) {
    const r = framework.roles.get(f.path);
    f.role = r?.role ?? null;
    f.framework = r?.framework ?? null;
  }

  const edges = edgesFrom(imports);
  return {
    version: OUTPUT_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    fileSource: source,
    adapters: framework.adapters,
    files,
    imports,
    edges,
    fan: fanCounts(files.map((f) => f.path), edges),
    coverage: coverageOf(files, imports),
    routes: framework.routes,
    routesWithheld: framework.routesWithheld,
  };
}
