import { ts } from "ts-morph";
import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import type { RepoFile } from "../types.ts";
import { defaultExportLine, exportedMethods, readSetting, stringArray, type Setting } from "./js-syntax.ts";
import { reactRoleOf } from "./react.ts";
import { baseName, isScript, literalString, packagesDepending, syntaxOf, withheldList } from "./shared.ts";
import type { NextjsRole } from "./taxonomy.ts";

// Next.js knows what a file is by where it sits and what it's called, and the
// URL a page answers is that same position. Everything here is read from paths
// and syntax; anything that would need the config to be run is withheld.

const DEFAULT_EXTENSIONS = ["tsx", "ts", "jsx", "js"];
const CONFIG = /^next\.config\.[mc]?[jt]s$/;

/** One Next.js application: a package that depends on next. */
type App = {
  /** Its package directory, "" for the repository root. */
  root: string;
  /** Where app/, pages/ and middleware sit: the root, or its src/. */
  base: string;
  hasAppDir: boolean;
  hasPagesDir: boolean;
  config: string | null;
  basePath: Setting<string>;
  extensions: Setting<string[]>;
};

const prefix = (dir: string) => (dir ? `${dir}/` : "");

function findApps(input: AdapterScope): App[] {
  const paths = input.files.map((f) => f.path);
  const has = (dir: string) => paths.some((p) => p.startsWith(`${dir}/`));
  return input.roots.map((root) => {
    const r = prefix(root);
    // Next ignores src/app and src/pages when either sits at the root.
    const rootDirs = has(`${r}app`) || has(`${r}pages`);
    const base = !rootDirs && (has(`${r}src/app`) || has(`${r}src/pages`)) ? `${r}src/` : r;
    const config = paths.find((p) => p.startsWith(r) && !p.slice(r.length).includes("/") && CONFIG.test(baseName(p))) ?? null;
    const text = config === null ? null : input.read(config);
    const sf = config !== null && text !== null ? syntaxOf(config, text) : null;
    return {
      root,
      base,
      hasAppDir: has(`${base}app`),
      hasPagesDir: has(`${base}pages`),
      config,
      basePath: sf ? readSetting(sf, "basePath", literalString) : { kind: "unset" },
      extensions: sf ? readSetting(sf, "pageExtensions", stringArray) : { kind: "unset" },
    };
  });
}

/** The app a file belongs to: the deepest one whose package contains it. */
function appOf(apps: readonly App[], path: string): App | null {
  let best: App | null = null;
  for (const a of apps) {
    if (path.startsWith(prefix(a.root)) && (!best || a.root.length > best.root.length)) best = a;
  }
  return best;
}

/** "page" for page.tsx, honouring pageExtensions; null if it isn't a page extension. */
function stemOf(name: string, extensions: readonly string[]): string | null {
  let stem: string | null = null;
  for (const ext of extensions) {
    if (name.endsWith(`.${ext}`) && (stem === null || name.length - ext.length - 1 < stem.length)) {
      stem = name.slice(0, -(ext.length + 1));
    }
  }
  return stem;
}

const APP_FILES = new Map<string, NextjsRole>([
  ["page", "page"],
  ["route", "api endpoint"],
  ["layout", "layout"],
  ["template", "layout"],
  ["loading", "loading state"],
  ["error", "error page"],
  ["global-error", "error page"],
  ["not-found", "error page"],
  ["forbidden", "error page"],
  ["unauthorized", "error page"],
]);

/** Whether the module opens with a "use server" directive. */
function usesServer(sf: ts.SourceFile): boolean {
  for (const s of sf.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === "use server") return true;
  }
  return false;
}

const SLOT = "page inside a parallel-route slot (@folder): it renders into another route's page rather than answering a URL of its own";
const INTERCEPT = "intercepting route ((.) folder): the URL it answers depends on where navigation came from";
const PAGES_API = "Pages Router API route: one handler answers every method, so no method can be read from it";
const STAR = "route handler re-exports everything from another module (export *), so its methods can't be read from this file";
const NO_DEFAULT = "page has no default export, so Next.js has nothing to render at its URL";

export const nextjs: Adapter = {
  name: "nextjs",
  claims: (input) => packagesDepending(input, "next"),
  reads: isScript,

  analyze(input) {
    const apps = findApps(input);
    const roles = new Map<string, string>();
    const withheld = withheldList();
    /** Routes per app, so an unreadable basePath can withhold that app's alone. */
    const routesOf = new Map<App, FoundRoute[]>(apps.map((a) => [a, []]));

    const parse = (file: RepoFile) => {
      const text = input.read(file.path);
      return text === null ? null : syntaxOf(file.path, text);
    };

    for (const file of input.owned) {
      const app = appOf(apps, file.path);
      if (!app || !file.path.startsWith(app.base)) continue;
      const rel = file.path.slice(app.base.length);
      const routes = routesOf.get(app)!;

      if (app.extensions.kind === "unreadable") {
        if ((app.hasAppDir && rel.startsWith("app/")) || (app.hasPagesDir && rel.startsWith("pages/"))) {
          withheld.add(
            "next.config sets pageExtensions to something that can't be read without running it, so which files are pages isn't known",
            `${app.config}:${app.extensions.line}`,
          );
        }
        continue;
      }
      const extensions = app.extensions.kind === "literal" ? app.extensions.value : DEFAULT_EXTENSIONS;

      if (rel.startsWith("app/")) {
        const parts = rel.slice("app/".length).split("/");
        const stem = stemOf(parts.pop()!, extensions);
        // A folder starting with _ is private: nothing inside it is routable.
        const role = stem === null ? undefined : APP_FILES.get(stem);
        if (role === undefined || parts.some((p) => p.startsWith("_"))) continue;
        roles.set(file.path, role);
        if (role !== "page" && role !== "api endpoint") continue;

        const segments: string[] = [];
        let slot = false;
        let intercept = false;
        for (const p of parts) {
          if (p.startsWith("@")) slot = true;
          else if (p.startsWith("(.")) intercept = true;
          else if (p.startsWith("(") && p.endsWith(")")) continue; // a route group adds nothing to the URL
          else segments.push(p.startsWith("%5F") ? `_${p.slice(3)}` : p);
        }
        const url = `/${segments.join("/")}`;
        if (intercept) {
          withheld.add(INTERCEPT, file.path);
          continue;
        }
        if (slot && role === "page") {
          withheld.add(SLOT, file.path);
          continue;
        }
        const sf = parse(file);
        if (!sf) continue;
        if (role === "page") {
          const line = defaultExportLine(sf);
          if (line === null) withheld.add(NO_DEFAULT, file.path);
          else routes.push({ file: file.path, method: "GET", path: url, line });
        } else {
          const { methods, star } = exportedMethods(sf);
          for (const m of methods) routes.push({ file: file.path, method: m.method, path: url, line: m.line });
          if (star) withheld.add(STAR, file.path);
        }
        continue;
      }

      if (rel.startsWith("pages/")) {
        const stem = stemOf(rel.slice("pages/".length), extensions);
        if (stem === null) continue;
        if (stem === "api" || stem.startsWith("api/")) {
          roles.set(file.path, "api endpoint");
          withheld.add(PAGES_API, file.path);
          continue;
        }
        if (stem === "_app" || stem === "_document") {
          roles.set(file.path, "layout");
          continue;
        }
        if (stem === "_error" || stem === "404" || stem === "500") {
          roles.set(file.path, "error page");
          continue;
        }
        roles.set(file.path, "page");
        const segments = stem.split("/");
        if (segments[segments.length - 1] === "index") segments.pop();
        const sf = parse(file);
        if (!sf) continue;
        const line = defaultExportLine(sf);
        if (line === null) withheld.add(NO_DEFAULT, file.path);
        else routes.push({ file: file.path, method: "GET", path: `/${segments.join("/")}`, line });
        continue;
      }

      const top = stemOf(rel, extensions);
      if (top === "middleware" || top === "proxy") roles.set(file.path, "middleware");
    }

    // What no path convention claimed: a "use server" module is a set of
    // server actions; otherwise React's own conventions apply.
    for (const file of input.owned) {
      if (roles.has(file.path)) continue;
      const text = input.read(file.path);
      if (text !== null && text.includes("use server")) {
        const sf = syntaxOf(file.path, text);
        if (usesServer(sf)) {
          roles.set(file.path, "server action");
          continue;
        }
      }
      const react = reactRoleOf(file.path);
      if (react) roles.set(file.path, react);
    }

    const routes: FoundRoute[] = [];
    for (const [app, found] of routesOf) {
      if (app.basePath.kind === "unreadable") {
        for (const r of found) {
          withheld.add(
            "next.config sets basePath to something that can't be read without running it, so no full pattern is known",
            `${r.file}:${r.line}`,
          );
        }
        continue;
      }
      const base = app.basePath.kind === "literal" ? app.basePath.value : "";
      for (const r of found) routes.push({ ...r, path: base && r.path === "/" ? base : `${base}${r.path}` });
    }
    return { roles, routes, routesWithheld: withheld.list() };
  },
};
