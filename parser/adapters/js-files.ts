import { ts } from "ts-morph";
import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import { HTTP_METHODS } from "../types.ts";
import { exportNames, exportedMethods, readSetting } from "./js-syntax.ts";
import { reactRoleOf } from "./react.ts";
import { baseName, conventionRole, isScript, lineOf, literalString, packagesDepending, syntaxOf, withheldList } from "./shared.ts";

// Frameworks whose routes are files: where a file sits is its URL, and what
// it exports (or, for Nuxt's server routes, what its name ends in) is its
// method. Each has a config that can move every route under a base path; a
// base written literally is applied, one that isn't withholds them all.

const prefix = (dir: string) => (dir ? `${dir}/` : "");
const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

type Withheld = ReturnType<typeof withheldList>;

/** The config file a package root holds, parsed; null when it has none. */
function config(scope: AdapterScope, root: string, name: RegExp): { path: string; sf: ts.SourceFile } | null {
  const path = scope.files.map((f) => f.path).find((p) => p.startsWith(prefix(root)) && !p.slice(prefix(root).length).includes("/") && name.test(baseName(p)));
  const text = path ? scope.read(path) : null;
  return path && text !== null ? { path, sf: syntaxOf(path, text) } : null;
}

/** A base path from config: "" when unset, the literal when plain, null (withheld with a reason) when not. */
function basePath(cfg: { path: string; sf: ts.SourceFile } | null, key: string, w: Withheld, routes: readonly FoundRoute[]): string | null {
  if (!cfg) return "";
  const s = readSetting(cfg.sf, key, literalString);
  if (s.kind === "unset") return "";
  if (s.kind === "literal") return s.value.replace(/\/+$/, "");
  for (const r of routes) w.add(`${baseName(cfg.path)} sets ${key} to something that can't be read without running it, so no full pattern is known`, `${r.file}:${r.line}`);
  return null;
}

function withBase(base: string, path: string): string {
  if (!base) return path;
  const b = base.startsWith("/") ? base : `/${base}`;
  return path === "/" ? b : b + path;
}

/** Routes found per package root, then put under that root's base path. */
function finish(found: Map<string, FoundRoute[]>, base: (root: string, routes: FoundRoute[]) => string | null): FoundRoute[] {
  const out: FoundRoute[] = [];
  for (const [root, routes] of found) {
    const b = base(root, routes);
    if (b === null) continue;
    for (const r of routes) out.push({ ...r, path: withBase(b, r.path) });
  }
  return out;
}

const rootOf = (roots: readonly string[], path: string) =>
  roots.filter((r) => r === "" || path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];

/** Route groups "(name)" add nothing to a URL. */
const ungrouped = (segments: readonly string[]) => segments.filter((s) => !/^\(.*\)$/.test(s));

// ---------------------------------------------------------------- SvelteKit

export const sveltekit: Adapter = {
  name: "sveltekit",
  claims: (input) => packagesDepending(input, "@sveltejs/kit"),
  reads: (path) => isScript(path) || path.endsWith(".svelte"),

  analyze(scope) {
    const roles = new Map<string, string>();
    const w = withheldList();
    const found = new Map<string, FoundRoute[]>(scope.roots.map((r) => [r, []]));

    for (const f of scope.owned) {
      const root = rootOf(scope.roots, f.path);
      const rel = f.path.slice(prefix(root).length);
      const name = baseName(rel);
      if (/^src\/hooks(\.(server|client))?\.[jt]s$/.test(rel)) {
        roles.set(f.path, "hook");
        continue;
      }
      if (!rel.startsWith("src/routes/") || !name.startsWith("+")) {
        if (name.endsWith(".svelte")) roles.set(f.path, "component");
        continue;
      }
      const dirs = rel.slice("src/routes/".length).split("/").slice(0, -1);
      const url = `/${ungrouped(dirs).join("/")}`;
      const routes = found.get(root)!;
      if (/^\+page(\.server)?\.(svelte|[jt]s)$/.test(name)) {
        roles.set(f.path, "page");
        if (name === "+page.svelte") routes.push({ file: f.path, method: "GET", path: url, line: 1 });
        if (/^\+page\.server\.[jt]s$/.test(name)) {
          const text = scope.read(f.path);
          const actions = text === null ? undefined : exportNames(syntaxOf(f.path, text)).names.get("actions");
          // Form actions are POSTs to the page's own URL.
          if (actions !== undefined) routes.push({ file: f.path, method: "POST", path: url, line: actions });
        }
      } else if (/^\+server\.[jt]s$/.test(name)) {
        roles.set(f.path, "endpoint");
        const text = scope.read(f.path);
        if (text === null) continue;
        const sf = syntaxOf(f.path, text);
        const { methods, star } = exportedMethods(sf);
        for (const m of methods) routes.push({ file: f.path, method: m.method, path: url, line: m.line });
        if (star) w.add("endpoint re-exports everything from another module (export *), so its methods can't be read here", f.path);
        const fallback = exportNames(sf).names.get("fallback");
        if (fallback !== undefined) w.add("a fallback handler answers every other method", `${f.path}:${fallback}`);
      } else if (/^\+layout/.test(name)) roles.set(f.path, "layout");
      else if (/^\+error/.test(name)) roles.set(f.path, "error page");
    }

    const routes = finish(found, (root, rs) => {
      const cfg = config(scope, root, /^svelte\.config\.[mc]?[jt]s$/);
      if (cfg && readSetting(cfg.sf, "routes", literalString).kind !== "unset") {
        for (const r of rs) w.add("svelte.config moves the routes folder, which isn't followed", `${r.file}:${r.line}`);
        return null;
      }
      return cfg && readSetting(cfg.sf, "paths", () => null).kind !== "unset" ? basePath(cfg, "base", w, rs) : "";
    });
    return { roles, routes, routesWithheld: w.list() };
  },
};

// --------------------------------------------------------------------- Nuxt

const NUXT_FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["layout", ["layouts"]],
  ["middleware", ["middleware"]],
  ["composable", ["composables"]],
  ["plugin", ["plugins"]],
  ["store", ["stores"]],
  ["component", ["components"]],
];

export const nuxt: Adapter = {
  name: "nuxt",
  claims: (input) => packagesDepending(input, "nuxt"),
  reads: (path) => isScript(path) || path.endsWith(".vue"),

  analyze(scope) {
    const roles = new Map<string, string>();
    const w = withheldList();
    const found = new Map<string, FoundRoute[]>(scope.roots.map((r) => [r, []]));
    const paths = scope.files.map((f) => f.path);

    for (const root of scope.roots) {
      // Nuxt 4 keeps the app in app/; Nuxt 3 at the root.
      const src = paths.some((p) => p.startsWith(`${prefix(root)}app/pages/`) || p === `${prefix(root)}app/app.vue`) ? `${prefix(root)}app/` : prefix(root);
      const cfg = config(scope, root, /^nuxt\.config\.[mc]?[jt]s$/);
      const i18n = cfg !== null && cfg.sf.text.includes("@nuxtjs/i18n");
      const routes = found.get(root)!;

      for (const f of scope.owned.filter((x) => rootOf(scope.roots, x.path) === root)) {
        if (f.path.startsWith(`${src}pages/`)) {
          roles.set(f.path, "page");
          const rel = f.path.slice(`${src}pages/`.length).replace(/\.(vue|[jt]sx?|mjs)$/, "");
          const segs = ungrouped(rel.split("/"));
          if (segs[segs.length - 1] === "index") segs.pop();
          const text = scope.read(f.path) ?? "";
          if (/definePageMeta\s*\(\s*\{[^}]*\bpath\s*:/.test(text)) w.add("definePageMeta sets this page's path, which isn't read", f.path);
          else if (i18n) w.add("@nuxtjs/i18n adds locale prefixes to pages, which aren't read", f.path);
          else routes.push({ file: f.path, method: "GET", path: `/${segs.join("/")}`, line: 1 });
          continue;
        }
        const server = /^server\/(api|routes)\/(.+)$/.exec(f.path.slice(prefix(root).length));
        if (server) {
          roles.set(f.path, "api endpoint");
          const parts = server[2].replace(/\.(ts|js|mjs)$/, "").split("/");
          const last = parts.pop()!;
          const dot = last.lastIndexOf(".");
          const method = dot > 0 ? LOWER.get(last.slice(dot + 1)) : undefined;
          const stem = method ? last.slice(0, dot) : last;
          const segs = [...(server[1] === "api" ? ["api"] : []), ...parts, ...(stem === "index" ? [] : [stem])];
          if (!method) w.add("server route without a method in its file name answers every method", f.path);
          else routes.push({ file: f.path, method, path: `/${segs.join("/")}`, line: 1 });
          continue;
        }
        if (f.path.startsWith(`${prefix(root)}server/middleware/`)) {
          roles.set(f.path, "middleware");
          continue;
        }
        const role = conventionRole(f.path.slice(src.length), NUXT_FOLDERS) ?? (f.path.endsWith(".vue") ? "component" : null);
        if (role) roles.set(f.path, role);
      }
    }

    const routes = finish(found, (root, rs) => basePath(config(scope, root, /^nuxt\.config\.[mc]?[jt]s$/), "baseURL", w, rs));
    return { roles, routes, routesWithheld: w.list() };
  },
};

// ------------------------------------------------- Remix / React Router

/**
 * A flat route file name as a URL (Remix v2 and React Router's flatRoutes):
 * dots separate segments, `$id` is a parameter, `$` a splat, `(x)` optional,
 * a leading `_` a pathless layout, a trailing `_` only opts out of nesting,
 * and `[...]` escapes. Null for a pathless layout itself.
 */
function flatPath(id: string): { path: string; layout: boolean } {
  const segs: string[] = [];
  let cur = "";
  let bracket = false;
  for (const ch of id) {
    if (ch === "[") bracket = true;
    else if (ch === "]") bracket = false;
    else if (ch === "." && !bracket) {
      segs.push(cur);
      cur = "";
    } else cur += bracket ? `\u0000${ch}` : ch;
  }
  segs.push(cur);
  const out: string[] = [];
  let layout = false;
  segs.forEach((raw, i) => {
    const escaped = raw.includes("\u0000");
    const s = raw.replace(/\u0000/g, "");
    if (escaped) return out.push(s);
    if (s === "_index" && i === segs.length - 1) return;
    if (s.startsWith("_")) {
      if (i === segs.length - 1) layout = true;
      return;
    }
    const t = s.replace(/_$/, "");
    const optional = /^\(.*\)$/.test(t);
    const inner = optional ? t.slice(1, -1) : t;
    const seg = inner === "$" ? "*" : inner.startsWith("$") ? `:${inner.slice(1)}` : inner;
    out.push(optional ? `${seg}?` : seg);
  });
  return { path: `/${out.join("/")}`, layout };
}

export const remix: Adapter = {
  name: "remix",
  claims: (input) => [...new Set([...packagesDepending(input, "@remix-run/dev"), ...packagesDepending(input, "@react-router/dev")])],
  reads: isScript,

  analyze(scope) {
    const roles = new Map<string, string>();
    const w = withheldList();
    const routes: FoundRoute[] = [];
    const owned = new Set(scope.owned.map((f) => f.path));

    /** A route module's methods: GET when it renders or loads; an action answers every other method. */
    const methods = (file: string, path: string) => {
      const text = scope.read(file);
      if (text === null) return;
      const { names, star } = exportNames(syntaxOf(file, text));
      const get = names.get("default") ?? names.get("loader");
      if (get !== undefined) routes.push({ file, method: "GET", path, line: get });
      if (names.has("action")) w.add("an action answers every method other than GET, so none can be named", `${file}:${names.get("action")}`);
      if (star) w.add("route module re-exports everything from another module (export *)", file);
      roles.set(file, names.has("default") ? "route" : "resource route");
    };

    for (const root of scope.roots) {
      const app = `${prefix(root)}app/`;
      if (owned.has(`${app}root.tsx`) || owned.has(`${app}root.jsx`)) roles.set(owned.has(`${app}root.tsx`) ? `${app}root.tsx` : `${app}root.jsx`, "layout");
      const vite = config(scope, root, /^(vite|remix)\.config\.[mc]?[jt]s$/);
      if (vite && /\broutes\s*[:(]/.test(vite.sf.text) && /remix/.test(vite.path + vite.sf.text)) {
        w.add("routes are defined by a function in the Remix config, which isn't run", vite.path);
        continue;
      }

      const flat = () => {
        for (const f of scope.owned) {
          if (!f.path.startsWith(`${app}routes/`)) continue;
          const rel = f.path.slice(`${app}routes/`.length);
          const parts = rel.split("/");
          // A folder route's module is its route.tsx; anything else inside is colocated.
          let id: string;
          if (parts.length === 1) id = rel.replace(/\.[jt]sx?$/, "");
          else if (parts.length === 2 && /^route\.[jt]sx?$/.test(parts[1])) id = parts[0];
          else continue;
          const { path, layout } = flatPath(id);
          if (layout) roles.set(f.path, "layout");
          else methods(f.path, path);
        }
      };

      const configFile = [`${app}routes.ts`, `${app}routes.js`].find((p) => scope.files.some((f) => f.path === p));
      if (!configFile) {
        flat();
        continue;
      }
      // React Router's app/routes.ts: route(), index(), layout(), prefix(), and flatRoutes().
      const sf = syntaxOf(configFile, scope.read(configFile) ?? "");
      const exported = sf.statements.find(ts.isExportAssignment)?.expression;
      const list = exported && (ts.isSatisfiesExpression(exported) || ts.isAsExpression(exported)) ? exported.expression : exported;
      const walk = (node: ts.Expression | undefined, at: string[]) => {
        if (!node || !ts.isArrayLiteralExpression(node)) return w.add("routes config isn't a plain array", configFile);
        for (const el of node.elements) {
          const where = `${configFile}:${lineOf(sf, el)}`;
          const call = ts.isSpreadElement(el) ? el.expression : el;
          const inner = ts.isAwaitExpression(call) ? call.expression : ts.isParenthesizedExpression(call) && ts.isAwaitExpression(call.expression) ? call.expression.expression : call;
          if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) {
            w.add("routes config entry isn't a route(), index(), layout() or prefix() call", where);
            continue;
          }
          const fn = inner.expression.text;
          const a = inner.arguments;
          if (fn === "flatRoutes") {
            if (a.length > 0) w.add("flatRoutes() with options isn't read", where);
            else flat();
            continue;
          }
          const str = (i: number) => (a[i] ? literalString(a[i]) : null);
          if (fn === "index" || fn === "route") {
            const path = fn === "route" ? str(0) : "";
            const file = str(fn === "route" ? 1 : 0);
            if (path === null || file === null) {
              w.add(`${fn}() isn't written with plain strings`, where);
              continue;
            }
            const segs = [...at, ...path.split("/").filter(Boolean)];
            methods(`${app}${file.replace(/^\.\//, "")}`, `/${segs.join("/")}`);
            if (fn === "route" && a[2]) walk(a[2], segs);
          } else if (fn === "layout") {
            const file = str(0);
            if (file) roles.set(`${app}${file.replace(/^\.\//, "")}`, "layout");
            walk(a[1], at);
          } else if (fn === "prefix") {
            const p = str(0);
            if (p === null) w.add("prefix() isn't a plain string", where);
            else walk(a[1], [...at, ...p.split("/").filter(Boolean)]);
          } else w.add(`routes config calls ${fn}(), which isn't read`, where);
        }
      };
      walk(list, []);
    }

    for (const f of scope.owned) {
      if (roles.has(f.path)) continue;
      const r = reactRoleOf(f.path);
      if (r) roles.set(f.path, r);
    }
    return { roles, routes: routes.filter((r) => owned.has(r.file)), routesWithheld: w.list() };
  },
};

// -------------------------------------------------------------------- Astro

const ASTRO_FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["layout", ["layouts"]],
  ["content", ["content"]],
  ["component", ["components"]],
];

export const astro: Adapter = {
  name: "astro",
  claims: (input) => packagesDepending(input, "astro"),
  reads: (path) => isScript(path) || /\.(astro|md|mdx|html)$/.test(path),

  analyze(scope) {
    const roles = new Map<string, string>();
    const w = withheldList();
    const found = new Map<string, FoundRoute[]>(scope.roots.map((r) => [r, []]));
    for (const root of scope.roots) {
      const pages = `${prefix(root)}src/pages/`;
      const cfg = config(scope, root, /^astro\.config\.[mc]?[jt]s$/);
      const i18n = cfg !== null && readSetting(cfg.sf, "i18n", () => null).kind !== "unset";
      const routes = found.get(root)!;
      for (const f of scope.owned.filter((x) => rootOf(scope.roots, x.path) === root)) {
        if (!f.path.startsWith(pages)) {
          const role = conventionRole(f.path.slice(prefix(root).length), ASTRO_FOLDERS);
          if (role) roles.set(f.path, role);
          continue;
        }
        const rel = f.path.slice(pages.length);
        // Files and folders starting with _ aren't pages.
        if (rel.split("/").some((p) => p.startsWith("_"))) continue;
        const page = /\.(astro|md|mdx|html)$/.test(rel);
        const segs = rel.replace(/\.(astro|md|mdx|html|[mc]?[jt]sx?)$/, "").split("/");
        if (segs[segs.length - 1] === "index") segs.pop();
        const url = `/${segs.join("/")}`;
        if (page) {
          roles.set(f.path, "page");
          if (i18n) w.add("i18n routing adds locale prefixes to pages, which aren't read", f.path);
          else routes.push({ file: f.path, method: "GET", path: url, line: 1 });
          continue;
        }
        roles.set(f.path, "endpoint");
        const text = scope.read(f.path);
        if (text === null) continue;
        const sf = syntaxOf(f.path, text);
        for (const m of exportedMethods(sf).methods) routes.push({ file: f.path, method: m.method, path: url, line: m.line });
        const all = exportNames(sf).names.get("ALL");
        if (all !== undefined) w.add("an ALL handler answers every method", `${f.path}:${all}`);
      }
    }
    const routes = finish(found, (root, rs) => basePath(config(scope, root, /^astro\.config\.[mc]?[jt]s$/), "base", w, rs));
    return { roles, routes, routesWithheld: w.list() };
  },
};

// ------------------------------------------------- Angular and Vue (roles)

const ANGULAR = /\.(component|service|module|directive|pipe|guard|interceptor|resolver|routes|store|reducer|effects|selectors|actions)\.ts$/;
const ANGULAR_ROLE: Record<string, string> = {
  component: "component", service: "service", module: "module", directive: "directive", pipe: "pipe",
  guard: "guard", interceptor: "interceptor", resolver: "resolver", routes: "routing",
  store: "state", reducer: "state", effects: "state", selectors: "state", actions: "state",
};

// Angular's routes are client-side configuration: which component shows for
// a URL in the browser, not a request the server answers. Roles only.
export const angular: Adapter = {
  name: "angular",
  claims: (input) => packagesDepending(input, "@angular/core"),
  reads: isScript,
  analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const m = ANGULAR.exec(f.path);
      if (m) roles.set(f.path, ANGULAR_ROLE[m[1]]);
      else if (/-routing\.module\.ts$/.test(f.path)) roles.set(f.path, "routing");
    }
    return { roles, routes: [], routesWithheld: [] };
  },
};

const VUE_FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["view", ["views", "pages"]],
  ["composable", ["composables"]],
  ["store", ["stores", "store"]],
  ["router", ["router"]],
  ["plugin", ["plugins"]],
  ["component", ["components"]],
];

// Vue Router, like Angular's, maps URLs in the browser. Roles only.
export const vue: Adapter = {
  name: "vue",
  claims: (input) => packagesDepending(input, "vue"),
  reads: (path) => isScript(path) || path.endsWith(".vue"),
  analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = conventionRole(f.path, VUE_FOLDERS) ?? (f.path.endsWith(".vue") ? "component" : /^use[A-Z]/.test(baseName(f.path)) ? "composable" : null);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes: [], routesWithheld: [] };
  },
};

