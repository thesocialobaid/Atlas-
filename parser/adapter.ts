import type { ImportRecord, RepoFile, Route, Withheld } from "./types.ts";

/** What every adapter is shown: every node, its text, and the imports the parser resolved. */
export type AdapterInput = {
  files: readonly RepoFile[];
  /** Text of a node, or null if it isn't one or can't be read. */
  read(path: string): string | null;
  /** Every import record. Only resolved ones point at files. */
  imports: readonly ImportRecord[];
};

/** One adapter's share of the repository. */
export type AdapterScope = AdapterInput & {
  /** The package directories it claimed and kept ("" for the root). */
  roots: readonly string[];
  /** The files it owns: under one of its roots, in a language it reads, claimed by nothing deeper. */
  owned: readonly RepoFile[];
};

/** A route before it's attributed to the adapter that read it. */
export type FoundRoute = Omit<Route, "framework">;

export type AdapterOutput = {
  /** Path to role, for owned files only. Files it has nothing to say about are left out. */
  roles: Map<string, string>;
  routes: FoundRoute[];
  routesWithheld: Omit<Withheld, "framework">[];
};

/**
 * Framework knowledge lives here and nowhere in the parser. An adapter may
 * recognise a project, give files roles and read routes; it never adds or
 * removes edges.
 */
export type Adapter = {
  name: string;
  /** Package directories whose manifest declares this framework. */
  claims(input: AdapterInput): string[];
  /** The files it can say anything about: its language's, by path. */
  reads(path: string): boolean;
  analyze(scope: AdapterScope): AdapterOutput | Promise<AdapterOutput>;
};

export type Framework = {
  /** Adapters that own at least one file, in detection order. */
  adapters: string[];
  /** Path to the adapter that gave it its role. */
  roles: Map<string, { role: string; framework: string }>;
  routes: Route[];
  routesWithheld: Withheld[];
};

/**
 * Every adapter claims the packages that declare it. A file belongs to the
 * deepest claimed directory whose adapter reads its language; for the same
 * directory, the earlier adapter in the fixed order wins.
 */
export async function applyAdapters(adapters: readonly Adapter[], input: AdapterInput): Promise<Framework> {
  const claims = adapters.map((a) => ({ adapter: a, roots: new Set(a.claims(input)) }));
  const owned = new Map<Adapter, RepoFile[]>();
  for (const f of input.files) {
    let best: { adapter: Adapter; depth: number } | null = null;
    for (const { adapter, roots } of claims) {
      if (!adapter.reads(f.path)) continue;
      for (const root of roots) {
        if (root !== "" && !f.path.startsWith(`${root}/`)) continue;
        const depth = root === "" ? 0 : root.split("/").length;
        // Strictly deeper only: at equal depth the earlier adapter keeps it.
        if (!best || depth > best.depth) best = { adapter, depth };
      }
    }
    if (!best) continue;
    const list = owned.get(best.adapter);
    if (list) list.push(f);
    else owned.set(best.adapter, [f]);
  }

  const out: Framework = { adapters: [], roles: new Map(), routes: [], routesWithheld: [] };
  for (const { adapter, roots } of claims) {
    const files = owned.get(adapter);
    if (!files) continue;
    out.adapters.push(adapter.name);
    const result = await adapter.analyze({ ...input, roots: [...roots], owned: files });
    const mine = new Set(files.map((f) => f.path));
    for (const [path, role] of result.roles) {
      if (mine.has(path)) out.roles.set(path, { role, framework: adapter.name });
    }
    // A route is its file, method and pattern. Declared twice in one file
    // (two names on one Symfony action, say), it's still one route; the first
    // declaration is the one shown.
    const seen = new Set(out.routes.map((r) => `${r.file}\n${r.method}\n${r.path}`));
    for (const r of result.routes) {
      const key = `${r.file}\n${r.method}\n${r.path}`;
      if (!mine.has(r.file) || seen.has(key)) continue;
      seen.add(key);
      out.routes.push({ ...r, framework: adapter.name });
    }
    out.routesWithheld.push(...result.routesWithheld.map((w) => ({ ...w, framework: adapter.name })));
  }
  return out;
}
