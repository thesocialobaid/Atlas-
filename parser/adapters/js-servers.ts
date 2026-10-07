import { ts } from "ts-morph";
import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { conventionRole, isScript, lineOf, literalString, packagesDepending, syntaxOf, withheldList } from "./shared.ts";

// Fastify, Hono and Koa build a server from objects: an app, routers or
// plugins with prefixes, and routes registered on them with calls. A router
// is identified by where it's declared; references to it are followed through
// the file's scopes and through imports the parser resolved, to the export
// they name. Anything reached another way is withheld.

const UPPER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

type Kind = "fastify" | "hono" | "koa";

type Spec = {
  kind: Kind;
  /** Package a constructor is imported from, and whether it's called with `new`. */
  constructors: readonly { module: string; isNew: boolean; role: "app" | "router" }[];
  verbs: ReadonlyMap<string, HttpMethod>;
  any: readonly string[];
  join(prefix: string, path: string): string | null;
};

const SPECS: Record<Kind, Spec> = {
  fastify: {
    kind: "fastify",
    constructors: [{ module: "fastify", isNew: false, role: "app" }],
    verbs: UPPER,
    any: ["all"],
    // Fastify answers a prefixed "/" at the prefix itself.
    join: (prefix, path) => (prefix === "" ? path : path === "/" || path === "" ? prefix.replace(/\/$/, "") || "/" : prefix.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`)),
  },
  hono: {
    kind: "hono",
    constructors: [{ module: "hono", isNew: true, role: "router" }],
    verbs: new Map([...UPPER].filter(([m]) => m !== "head")),
    any: ["all"],
    // Hono's mergePath: a sub-app's "/" is the mount path itself.
    join: (prefix, path) => (prefix === "" ? path : path === "/" ? prefix.replace(/\/$/, "") || "/" : prefix.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`)),
  },
  koa: {
    kind: "koa",
    constructors: [
      { module: "koa", isNew: true, role: "app" },
      { module: "@koa/router", isNew: true, role: "router" },
      { module: "koa-router", isNew: true, role: "router" },
    ],
    verbs: new Map<string, HttpMethod>([...UPPER, ["del", "DELETE"]]),
    any: ["all"],
    join: (prefix, path) => (prefix === "" ? path : path === "/" ? prefix.replace(/\/$/, "") || "/" : prefix.replace(/\/$/, "") + path),
  },
};

type File = {
  path: string;
  sf: ts.SourceFile;
  /** Local import name → the resolved file and the export it names ("default", a name, or "*"). */
  imports: Map<string, { file: string; name: string } | { external: string; name: string }>;
};

/** A router reference: its id, and the prefix it carries itself (a Hono basePath, a Koa Router's prefix option). */
type Ref = { id: string; pre: string | null };

const FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["handler", ["handlers", "controllers", "controller"]],
  ["middleware", ["middleware", "middlewares"]],
  ["service", ["services", "service"]],
  ["model", ["models", "model", "schemas", "entities"]],
  ["plugin", ["plugins"]],
];

function makeAdapter(spec: Spec): Adapter {
  const packages = [...new Set(spec.constructors.map((c) => c.module))];
  return {
    name: spec.kind,
    claims: (input) => [...new Set(packagesDepending(input, packages[0]))],
    reads: isScript,

    analyze(scope: AdapterScope) {
      const w = withheldList();
      const declared: Declared[] = [];
      const mounts: Mount[] = [];
      const apps = new Set<string>();
      const routeFiles = new Set<string>();

      const files = new Map<string, File>();
      const fileOf = (path: string): File | null => {
        if (files.has(path)) return files.get(path)!;
        const text = scope.read(path);
        if (text === null || !isScript(path)) return null;
        const sf = syntaxOf(path, text);
        const imports: File["imports"] = new Map();
        for (const s of sf.statements) {
          if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.importClause?.isTypeOnly) continue;
          const spec_ = s.moduleSpecifier.text;
          const rec = scope.imports.find((r) => r.from === path && r.specifier === spec_ && r.line === lineOf(sf, s));
          const target = (name: string) =>
            rec?.outcome === "resolved" ? { file: rec.to[0], name } : { external: spec_, name };
          const clause = s.importClause;
          if (clause?.name) imports.set(clause.name.text, target("default"));
          const nb = clause?.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) imports.set(nb.name.text, target("*"));
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, target((el.propertyName ?? el.name).text));
        }
        const f = { path, sf, imports };
        files.set(path, f);
        return f;
      };

      /** The declaration a name refers to at a point: a parameter, a variable, a function, or an import. */
      const declOf = (f: File, at: ts.Node, name: string): ts.Node | { file: string; name: string } | { external: string; name: string } | null => {
        for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
          if (ts.isFunctionLike(n)) {
            const p = n.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
            if (p) return p;
          }
          const statements = ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) ? n.statements : null;
          for (const s of statements ?? []) {
            if (ts.isVariableStatement(s)) {
              for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
            } else if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
          }
        }
        return f.imports.get(name) ?? null;
      };

      /** What a module exports under a name: a local declaration, or a default-exported expression. */
      const exported = (path: string, name: string, depth: number): { file: File; node: ts.Node } | null => {
        const f = fileOf(path);
        if (!f || depth > 8) return null;
        for (const s of f.sf.statements) {
          if (name === "default" && ts.isExportAssignment(s) && !s.isExportEquals) return { file: f, node: s.expression };
          if (name === "default" && ts.isFunctionDeclaration(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return { file: f, node: s };
          if (ts.isVariableStatement(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { file: f, node: d };
          }
          if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return { file: f, node: s };
          if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause) && !s.moduleSpecifier) {
            const el = s.exportClause.elements.find((e) => e.name.text === name);
            if (el) {
              const local = (el.propertyName ?? el.name).text;
              const d = declOf(f, f.sf.statements[0] ?? f.sf, local);
              return d && "kind" in d ? { file: f, node: d } : d && "file" in d ? exported(d.file, d.name, depth + 1) : null;
            }
          }
        }
        return null;
      };

      /** Whether a call constructs one of this framework's objects. */
      const constructs = (f: File, node: ts.Node): "app" | "router" | null => {
        const isNew = ts.isNewExpression(node);
        if (!isNew && !ts.isCallExpression(node)) return null;
        const callee = node.expression;
        if (!ts.isIdentifier(callee)) return null;
        const imp = f.imports.get(callee.text);
        if (!imp || !("external" in imp)) return null;
        const c = spec.constructors.find((x) => x.module === imp.external && x.isNew === isNew);
        return c ? c.role : null;
      };

      /** The router an expression is, following names to their declarations. */
      const refOf = (f: File, node: ts.Node | undefined, depth = 0): Ref | null => {
        if (!node || depth > 16) return null;
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
          return refOf(f, node.expression, depth + 1);
        }
        if (ts.isIdentifier(node)) {
          const d = declOf(f, node, node.text);
          if (!d) return null;
          if ("kind" in d) {
            if (ts.isParameter(d)) return { id: `${f.path}@p${d.getStart(f.sf)}`, pre: "" };
            if (ts.isVariableDeclaration(d)) return d.initializer ? refOf(f, d.initializer, depth + 1) : null;
            return null;
          }
          if ("file" in d) {
            const e = exported(d.file, d.name, depth + 1);
            if (!e) return null;
            return ts.isVariableDeclaration(e.node) ? refOf(e.file, e.node.initializer, depth + 1) : refOf(e.file, e.node, depth + 1);
          }
          return null;
        }
        const made = constructs(f, node);
        if (made) {
          const id = `${f.path}@${node.getStart(f.sf)}`;
          if (made === "app") apps.add(id);
          // new Router({ prefix: "/api" }) carries its prefix into every route.
          let pre: string | null = "";
          const opts = ts.isNewExpression(node) ? node.arguments?.[0] : undefined;
          if (spec.kind === "koa" && opts && ts.isObjectLiteralExpression(opts)) {
            const p = opts.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === "prefix");
            if (p) pre = ts.isPropertyAssignment(p) ? literalString(p.initializer) : null;
          }
          return { id, pre };
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const member = node.expression.name.text;
          const recv = refOf(f, node.expression.expression, depth + 1);
          if (!recv) return null;
          // Hono's basePath() is the same app with a prefix on everything registered through it.
          if (spec.kind === "hono" && member === "basePath") {
            const p = node.arguments[0] ? literalString(node.arguments[0]) : null;
            return { id: recv.id, pre: recv.pre === null || p === null ? null : spec.join(recv.pre, p) };
          }
          // Registration calls return the same object, so chains keep it.
          if (spec.verbs.has(member) || ["use", "route", "on", "register", "addHook", "decorate"].includes(member)) return recv;
        }
        return null;
      };

      /** The router a plugin function is handed: its first parameter. */
      const pluginParam = (f: File, node: ts.Node | undefined, depth = 0): { id: string; wrapped: boolean } | null => {
        if (!node || depth > 8) return null;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
          const p = node.parameters[0];
          return p ? { id: `${f.path}@p${p.getStart(f.sf)}`, wrapped: false } : null;
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const imp = f.imports.get(node.expression.text);
          if (imp && "external" in imp && imp.external === "fastify-plugin") {
            const inner = pluginParam(f, node.arguments[0], depth + 1);
            return inner ? { ...inner, wrapped: true } : null;
          }
          return null;
        }
        if (ts.isIdentifier(node)) {
          const d = declOf(f, node, node.text);
          if (!d) return null;
          if ("kind" in d) return ts.isVariableDeclaration(d) ? pluginParam(f, d.initializer, depth + 1) : pluginParam(f, d, depth + 1);
          if ("file" in d) {
            const e = exported(d.file, d.name, depth + 1);
            return e ? pluginParam(e.file, ts.isVariableDeclaration(e.node) ? e.node.initializer : e.node, depth + 1) : null;
          }
        }
        return null;
      };

      const objectProp = (obj: ts.Expression | undefined, key: string): ts.Expression | undefined | null => {
        if (!obj) return undefined;
        if (!ts.isObjectLiteralExpression(obj)) return null;
        const p = obj.properties.find((x) => (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) && ts.isIdentifier(x.name) && x.name.text === key);
        if (!p) return undefined;
        return ts.isPropertyAssignment(p) ? p.initializer : null;
      };

      /** "GET" or ["GET", "POST"], as methods; null if any is computed or unknown. */
      const methodList = (node: ts.Expression | undefined | null): HttpMethod[] | null => {
        if (!node) return null;
        const items = ts.isArrayLiteralExpression(node) ? [...node.elements] : [node];
        const out: HttpMethod[] = [];
        for (const e of items) {
          const s = literalString(e);
          const m = s === null ? undefined : UPPER.get(s.toLowerCase());
          if (!m) return null;
          out.push(m);
        }
        return out;
      };

      const importedBy = new Set(scope.imports.filter((r) => r.outcome === "resolved").flatMap((r) => r.to));

      for (const owned of scope.owned) {
        const f = fileOf(owned.path);
        if (!f) continue;
        const visit = (node: ts.Node) => {
          ts.forEachChild(node, visit);

          // Serving a Hono app: serve({ fetch: app.fetch }), handle(app), export default app.
          if (spec.kind === "hono") {
            if (ts.isPropertyAccessExpression(node) && node.name.text === "fetch") {
              const r = refOf(f, node.expression);
              if (r) apps.add(r.id);
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["handle", "fire"].includes(node.expression.text)) {
              const r = refOf(f, node.arguments[0]);
              if (r) apps.add(r.id);
            }
            // A default export from a file nothing imports is the entry point.
            if (ts.isExportAssignment(node) && !importedBy.has(f.path)) {
              const r = refOf(f, node.expression);
              if (r) apps.add(r.id);
            }
          }

          if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
          const member = node.expression.name.text;
          const recv = refOf(f, node.expression.expression);
          if (!recv) return;
          const args = node.arguments;
          const line = lineOf(f.sf, node.expression.name);
          const where = `${f.path}:${line}`;

          const declare = (method: HttpMethod, pathNode: ts.Expression | undefined) => {
            const p = pathNode ? literalString(pathNode) : null;
            if (p === null) return w.add("path isn't a plain string", where);
            if (recv.pre === null) return w.add("the router's own prefix isn't written plainly", where);
            routeFiles.add(f.path);
            declared.push({ router: recv.id, method, path: recv.pre ? spec.join(recv.pre, p) ?? p : p, file: f.path, line });
          };

          const verb = spec.verbs.get(member);
          if (verb) {
            // koa-router: router.get("name", "/path", handler) names the route first.
            const second = args[1] && literalString(args[1]);
            declare(verb, spec.kind === "koa" && second !== null && second !== undefined && args.length > 2 ? args[1] : args[0]);
            return;
          }
          if (spec.any.includes(member)) return w.add(`${member}() answers every method`, where);

          if (spec.kind === "fastify" && member === "route") {
            const url = objectProp(args[0], "url") ?? objectProp(args[0], "path");
            const methods = methodList(objectProp(args[0], "method"));
            if (!url || methods === null) return w.add("route() options aren't plain strings the route table carries", where);
            for (const m of methods) declare(m, url);
            return;
          }
          if (spec.kind === "hono" && member === "on") {
            const methods = methodList(args[0]);
            if (methods === null) return w.add("on()'s methods aren't plain strings the route table carries", where);
            for (const m of methods) declare(m, args[1]);
            return;
          }
          if (spec.kind === "fastify" && member === "register") {
            const opts = args[1];
            const prefixNode = objectProp(opts, "prefix");
            const prefix = prefixNode === undefined ? "" : prefixNode === null ? null : literalString(prefixNode);
            const target = args[0];
            const imp = target && ts.isIdentifier(target) ? f.imports.get(target.text) : undefined;
            if (imp && "external" in imp && imp.external === "@fastify/autoload") return w.add("routes loaded from folders by @fastify/autoload aren't read", where);
            const plugin = pluginParam(f, target);
            if (!plugin) return; // An installed plugin (cors, helmet): no routes of this repository's.
            if (plugin.wrapped && prefix) return w.add("a prefix on a fastify-plugin-wrapped plugin has no effect, so its routes' paths aren't certain", where);
            mounts.push({ child: plugin.id, parent: recv.id, prefix: prefix === null ? null : prefix, where });
            return;
          }
          if (spec.kind === "hono" && member === "route") {
            const p = args[0] ? literalString(args[0]) : null;
            const child = refOf(f, args[1]);
            if (!child) return w.add("a sub-app mounted here couldn't be traced to where it's built", where);
            mounts.push({ child: child.id, parent: recv.id, prefix: p === null ? null : spec.join(recv.pre ?? "", p), where, why: recv.pre === null ? "a router it sits in has a prefix that isn't written plainly" : undefined });
            return;
          }
          if (spec.kind === "koa" && member === "use") {
            const hasPath = args.length > 1 && args[0] && (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0]));
            const p = hasPath ? literalString(args[0]) ?? "" : "";
            for (const a of hasPath ? args.slice(1) : args) {
              // router.routes() / router.middleware() hands the router over.
              if (ts.isCallExpression(a) && ts.isPropertyAccessExpression(a.expression) && ["routes", "middleware"].includes(a.expression.name.text)) {
                const child = refOf(f, a.expression.expression);
                if (child) mounts.push({ child: child.id, parent: recv.id, prefix: spec.join(recv.pre ?? "", p) ?? p, where });
                else w.add("a router mounted here couldn't be traced to where it's built", where);
              }
            }
            return;
          }
          if (spec.kind === "koa" && member === "prefix") w.add("prefix() changes a router's prefix after routes may be registered, which isn't followed", where);
        };
        visit(f.sf);
      }

      const routes: FoundRoute[] = [];
      for (const r of resolveMounts({ apps, mounts, declared }, spec.join, w.add)) {
        const path = r.path.startsWith("/") ? r.path : `/${r.path}`;
        routes.push({ ...r, path });
      }

      const roles = new Map<string, string>();
      for (const f of scope.owned) {
        const role = routeFiles.has(f.path) ? "router" : conventionRole(f.path, FOLDERS);
        if (role) roles.set(f.path, role);
      }
      return { roles, routes, routesWithheld: w.list() };
    },
  };
}

export const fastify = makeAdapter(SPECS.fastify);
export const hono = makeAdapter(SPECS.hono);
export const koa = makeAdapter(SPECS.koa);
