import type { FoundRoute } from "../adapter.ts";
import type { HttpMethod } from "../types.ts";

// Frameworks that build an application out of routers mounted inside routers
// (FastAPI, Flask, Go's routers, Actix, Axum) all reduce to the same question:
// for a route declared on some router, what prefixes sit between it and an
// application? Each adapter reads the declarations and the mounts from
// syntax; this walks them. A route is emitted once per complete path to an
// application, and withheld when any step of the way can't be read.

/** A router, by where it's defined: "file#name" or anything else unique. */
export type RouterId = string;

export type Mount = {
  child: RouterId;
  parent: RouterId;
  /** Null when the prefix can't be read; `why` then says why. */
  prefix: string | null;
  why?: string;
  /** "file:line" of the mount, for the withheld reason. */
  where: string;
};

export type Declared = {
  router: RouterId;
  method: HttpMethod;
  /** As written on the router, before any mount's prefix. */
  path: string;
  file: string;
  line: number;
};

export type MountGraph = {
  /** Routers that are applications: served directly unless something mounts them. */
  apps: ReadonlySet<RouterId>;
  mounts: readonly Mount[];
  declared: readonly Declared[];
};

type Withhold = (reason: string, where: string) => void;

/**
 * `join(prefix, path)` is the framework's own rule for putting a mount prefix
 * in front of a path, or null for a combination it would treat in a way this
 * doesn't read.
 */
export function resolveMounts(graph: MountGraph, join: (prefix: string, path: string) => string | null, withhold: Withhold): FoundRoute[] {
  const parents = new Map<RouterId, Mount[]>();
  for (const m of graph.mounts) parents.set(m.child, [...(parents.get(m.child) ?? []), m]);

  const out: FoundRoute[] = [];
  const seen = new Set<string>();
  for (const d of graph.declared) {
    const where = `${d.file}:${d.line}`;
    const reasons = new Set<string>();
    const walk = (router: RouterId, path: string, visiting: ReadonlySet<RouterId>) => {
      const up = parents.get(router) ?? [];
      if (up.length === 0) {
        if (graph.apps.has(router)) {
          const key = `${d.file}\n${d.method}\n${path}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ file: d.file, method: d.method, path, line: d.line });
          }
        } else {
          reasons.add("its router isn't mounted on an application anywhere this can follow (passed in from elsewhere, mounted through something computed, or never mounted)");
        }
        return;
      }
      for (const m of up) {
        if (visiting.has(m.parent)) {
          reasons.add("its routers mount each other in a loop");
          continue;
        }
        if (m.prefix === null) {
          reasons.add(`${m.why ?? "a router it sits in is mounted with a prefix that isn't written literally"} (${m.where})`);
          continue;
        }
        const joined = join(m.prefix, path);
        if (joined === null) {
          reasons.add(`a mount prefix and a path combine in a way whose result isn't read here (${m.where})`);
          continue;
        }
        walk(m.parent, joined, new Set([...visiting, m.parent]));
      }
    };
    walk(d.router, d.path, new Set([d.router]));
    for (const r of reasons) withhold(r, where);
  }
  return out;
}
