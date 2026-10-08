import type { Adapter, FoundRoute } from "../adapter.ts";
import type { SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { pyArg, pyConditional, pyProject, type PyProject } from "./python.ts";
import { allDefined, conventionRole, plainString, pythonDepending, withheldList } from "./shared.ts";

// Litestar and Starlette declare an application as lists: route handlers,
// controllers and routers for Litestar; Route and Mount entries for
// Starlette. Each list is read where it's written, and names in it followed
// through imports the parser resolved.

const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

const FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["controller", ["controllers", "routes", "routers", "api", "endpoints"]],
  ["service", ["services"]],
  ["schema", ["schemas", "dto", "dtos"]],
  ["model", ["models"]],
  ["middleware", ["middleware"]],
];

/** A list literal's elements, following a name to the list it's assigned. */
function listOf(py: PyProject, file: string, node: SyntaxNode | null, depth = 0): { file: string; items: SyntaxNode[] } | null {
  if (!node || depth > 6) return null;
  if (node.type === "list" || node.type === "tuple") return { file, items: node.namedChildren };
  const t = py.resolve(file, node);
  const defs = t?.name ? py.file(t.file)?.defs.get(t.name) ?? [] : [];
  if (!t || defs.length !== 1 || defs[0].type !== "assignment") return null;
  return listOf(py, t.file, defs[0].childForFieldName("right"), depth + 1);
}

/** The single def, class or assignment a name resolves to. */
function definitionOf(py: PyProject, file: string, node: SyntaxNode): { file: string; node: SyntaxNode; name: string } | null {
  const t = py.resolve(file, node);
  const defs = t?.name ? py.file(t.file)?.defs.get(t.name) ?? [] : [];
  return t?.name && defs.length === 1 ? { file: t.file, node: defs[0], name: t.name } : null;
}

/** Litestar's path joining: segments without their slashes, one between each, none trailing. */
function litestarJoin(prefix: string, path: string): string {
  const segs = `${prefix}/${path}`.split("/").filter(Boolean);
  return `/${segs.join("/")}`;
}

// ----------------------------------------------------------------- Litestar

const LITESTAR_DECORATORS = new Map<string, HttpMethod | "route">([
  ["litestar.get", "GET"], ["litestar.post", "POST"], ["litestar.put", "PUT"], ["litestar.patch", "PATCH"],
  ["litestar.delete", "DELETE"], ["litestar.head", "HEAD"], ["litestar.route", "route"],
  ["litestar.handlers.get", "GET"], ["litestar.handlers.post", "POST"], ["litestar.handlers.put", "PUT"],
  ["litestar.handlers.patch", "PATCH"], ["litestar.handlers.delete", "DELETE"], ["litestar.handlers.head", "HEAD"],
]);

export const litestar: Adapter = {
  name: "litestar",
  claims: (input) => pythonDepending(input, "litestar"),
  reads: (path) => path.endsWith(".py"),

  async analyze(scope) {
    const py = await pyProject(scope);
    const w = withheldList();
    const declared: Declared[] = [];
    const mounts: Mount[] = [];
    const apps = new Set<string>();
    const routeFiles = new Set<string>();

    /** Paths a handler decorator gives: path=, a string, a list of strings, or "/" when none. */
    const pathsOf = (call: SyntaxNode): string[] | null => {
      const arg = pyArg(call, 0, "path");
      if (!arg) return ["/"];
      if (arg.type === "list") {
        return allDefined(arg.namedChildren.map((n) => plainString(n)));
      }
      const s = plainString(arg);
      return s === null ? null : [s];
    };

    /** A decorated function's handler declarations, on the router id given. */
    const handler = (file: string, def: SyntaxNode, router: string) => {
      const decorated = def.parent?.type === "decorated_definition" ? def.parent : null;
      for (const d of decorated?.namedChildren.filter((c) => c.type === "decorator") ?? []) {
        const call = d.namedChildren[0];
        if (call?.type !== "call") continue;
        const kind = LITESTAR_DECORATORS.get(py.externalCallee(file, call) ?? "");
        if (!kind) continue;
        const line = d.startPosition.row + 1;
        const where = `${file}:${line}`;
        let methods: HttpMethod[];
        if (kind === "route") {
          const m = pyArg(call, null, "http_method");
          const items = m?.type === "list" ? m.namedChildren : m ? [m] : [];
          const mapped = allDefined(items.map((i) => LOWER.get((plainString(i) ?? i.text.split(".").pop() ?? "").toLowerCase())));
          if (items.length === 0 || mapped === null) {
            w.add("@route's http_method isn't a plain method or list of methods", where);
            continue;
          }
          methods = mapped;
        } else methods = [kind];
        const paths = pathsOf(call);
        if (paths === null) {
          w.add("handler path isn't a plain string", where);
          continue;
        }
        routeFiles.add(file);
        for (const p of paths) for (const m of methods) declared.push({ router, method: m, path: p, file, line });
      }
    };

    /** A Controller subclass: its own `path`, and its handlers. */
    const controller = (file: string, cls: SyntaxNode, id: string): string | null => {
      let path: string | null = "/";
      for (const stmt of cls.childForFieldName("body")?.namedChildren ?? []) {
        const a = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
        if (a?.type === "assignment" && a.childForFieldName("left")?.text === "path") path = plainString(a.childForFieldName("right"));
        const fn = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : null;
        if (fn?.type === "function_definition") handler(file, fn, id);
      }
      return path;
    };

    /** Mounts every entry of a route_handlers list under a parent. */
    const handlers = (file: string, list: SyntaxNode | null, parent: string, where: string, depth: number) => {
      const items = listOf(py, file, list);
      if (!items) return w.add("route_handlers isn't a plain list", where);
      for (const item of items.items) {
        const at = `${items.file}:${item.startPosition.row + 1}`;
        const def = definitionOf(py, items.file, item);
        if (!def) {
          w.add("a route handler entry couldn't be traced to its definition", at);
          continue;
        }
        const id = `${def.file}#${def.name}`;
        if (def.node.type === "function_definition") {
          handler(def.file, def.node, id);
          mounts.push({ child: id, parent, prefix: "", where: at });
        } else if (def.node.type === "class_definition") {
          const p = controller(def.file, def.node, id);
          mounts.push({ child: id, parent, prefix: p, where: at, why: "a controller's path isn't a plain string" });
        } else if (def.node.type === "assignment") {
          const call = def.node.childForFieldName("right");
          if (call?.type !== "call" || !/Router$/.test(py.externalCallee(def.file, call) ?? "") || depth > 6) {
            w.add("a route handler entry isn't a handler, controller or Router", at);
            continue;
          }
          const p = plainString(pyArg(call, 0, "path"));
          mounts.push({ child: id, parent, prefix: p, where: at, why: "a router's path isn't a plain string" });
          handlers(def.file, pyArg(call, 1, "route_handlers"), id, at, depth + 1);
        }
      }
    };

    try {
      for (const f of scope.owned) {
        const file = py.file(f.path);
        for (const call of file?.root.descendantsOfType("call") ?? []) {
          const callee = py.externalCallee(f.path, call);
          if (callee !== "litestar.Litestar" && callee !== "litestar.app.Litestar") continue;
          const id = `${f.path}@${call.startIndex}`;
          apps.add(id);
          const where = `${f.path}:${call.startPosition.row + 1}`;
          if (pyConditional(call)) w.add("the application is created inside a condition", where);
          else handlers(f.path, pyArg(call, 0, "route_handlers"), id, where, 0);
        }
      }
    } finally {
      py.done();
    }

    const routes: FoundRoute[] = resolveMounts({ apps, mounts, declared }, litestarJoin, w.add).map((r) => ({ ...r, path: litestarJoin("", r.path) }));
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = routeFiles.has(f.path) ? "controller" : conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes, routesWithheld: w.list() };
  },
};

// ---------------------------------------------------------------- Starlette

export const starlette: Adapter = {
  name: "starlette",
  claims: (input) => pythonDepending(input, "starlette"),
  reads: (path) => path.endsWith(".py"),

  async analyze(scope) {
    const py = await pyProject(scope);
    const w = withheldList();
    const routes: FoundRoute[] = [];
    const routeFiles = new Set<string>();

    /** A Route's methods: methods= if given; an HTTPEndpoint class's handlers; else GET for a function. */
    const methodsOf = (file: string, call: SyntaxNode): HttpMethod[] | string => {
      const listed = pyArg(call, null, "methods");
      if (listed) {
        const items = listed.type === "list" ? listed.namedChildren.map((n) => plainString(n)) : [null];
        return allDefined(items.map((s) => (s ? LOWER.get(s.toLowerCase()) : undefined))) ?? "methods= isn't a plain list the route table carries";
      }
      const endpoint = pyArg(call, 1, "endpoint");
      const def = endpoint ? definitionOf(py, file, endpoint) : null;
      if (!def) return "endpoint couldn't be traced to its definition";
      if (def.node.type === "function_definition") return ["GET"];
      if (def.node.type === "class_definition") {
        const out: HttpMethod[] = [];
        for (const stmt of def.node.childForFieldName("body")?.namedChildren ?? []) {
          const fn = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : stmt;
          const m = fn?.type === "function_definition" ? LOWER.get(fn.childForFieldName("name")?.text ?? "") : undefined;
          if (m) out.push(m);
        }
        return out.length ? out : "endpoint class defines no handler methods of its own";
      }
      return "endpoint isn't a function or an endpoint class";
    };

    const walk = (file: string, list: SyntaxNode | null, prefix: string, where: string, depth: number) => {
      const items = listOf(py, file, list);
      if (!items || depth > 8) return w.add("routes isn't a plain list", where);
      for (const item of items.items) {
        const at = `${items.file}:${item.startPosition.row + 1}`;
        const callee = item.type === "call" ? py.externalCallee(items.file, item) ?? "" : "";
        const name = callee.split(".").pop();
        if (name === "WebSocketRoute") continue;
        if (pyConditional(item)) {
          w.add("route added inside a condition", at);
          continue;
        }
        const path = item.type === "call" ? plainString(pyArg(item, 0, "path")) : null;
        if (name === "Route") {
          if (path === null) {
            w.add("route path isn't a plain string", at);
            continue;
          }
          const methods = methodsOf(items.file, item);
          if (typeof methods === "string") w.add(methods, at);
          else {
            routeFiles.add(items.file);
            for (const m of methods) routes.push({ file: items.file, method: m, path: prefix + path, line: item.startPosition.row + 1 });
          }
        } else if (name === "Mount") {
          if (path === null) w.add("mount path isn't a plain string", at);
          else if (pyArg(item, null, "routes")) walk(items.file, pyArg(item, null, "routes"), prefix + path, at, depth + 1);
          else w.add("a mounted application's routes are its own, and aren't read", at);
        } else w.add("routes entry isn't a Route or Mount", at);
      }
    };

    try {
      for (const f of scope.owned) {
        for (const call of py.file(f.path)?.root.descendantsOfType("call") ?? []) {
          const callee = py.externalCallee(f.path, call);
          if (callee !== "starlette.applications.Starlette") continue;
          const where = `${f.path}:${call.startPosition.row + 1}`;
          const list = pyArg(call, null, "routes");
          if (list) walk(f.path, list, "", where, 0);
        }
      }
    } finally {
      py.done();
    }

    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = routeFiles.has(f.path) ? "controller" : conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes, routesWithheld: w.list() };
  },
};
