import type { AdapterScope, FoundRoute } from "../adapter.ts";
import type { SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { pyArg, pyConditional, pyHasKeyword, pyProject, pyStrings } from "./python.ts";
import { plainString, withheldList } from "./shared.ts";

// FastAPI and Flask build an application the same way: an app object, router
// objects (APIRouter, Blueprint) with their own prefix, routes declared on
// either with decorators, and routers mounted into apps or other routers.
// The differences — which calls mean what, and how a prefix meets a path —
// are the framework's spec below.

export type RouterSpec = {
  /** The package everything below is imported from. */
  module: string;
  /** The keyword a route's path may be passed as: "path" (FastAPI), "rule" (Flask). */
  pathKeyword: string;
  /** "flask.Flask" etc.: what constructing each kind looks like. */
  apps: readonly string[];
  routers: readonly string[];
  /** The keyword a router's own prefix is written in. */
  ownPrefix: string;
  /**
   * FastAPI puts a router's prefix into each route as it's declared; Flask
   * applies it when the blueprint is registered, where it can be overridden.
   */
  prefixAt: "declaration" | "mount";
  /** Decorator method names to the methods they fix, or "keyword" when the methods come from `methods=`. */
  decorators: ReadonlyMap<string, HttpMethod | "keyword">;
  /** Method name and argument positions of the imperative form: add_api_route / add_url_rule. */
  addRoute: { name: string; viewArg: { index: number; keyword: string } };
  /** Calls that mount a router: include_router, register_blueprint; and a sub-application mount, if any. */
  mount: { name: string; prefixKeyword: string };
  subApp: string | null;
  join(prefix: string, path: string): string | null;
};

const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

type Router = { id: string; kind: "app" | "router"; own: string | null; ambiguous: boolean };

export async function readRouters(scope: AdapterScope, spec: RouterSpec) {
  const py = await pyProject(scope);
  const withheld = withheldList();
  const routers = new Map<string, Router>();
  const declared: Declared[] = [];
  const mounts: Mount[] = [];
  const routeFiles = new Set<string>();
  const appFiles = new Set<string>();

  try {
    const files = scope.owned.filter((f) => f.path.endsWith(".py")).map((f) => py.file(f.path)).filter((f) => f !== null);

    // Every app and router object, by the file and name it's assigned to.
    for (const f of files) {
      for (const [name, nodes] of f.defs) {
        for (const node of nodes) {
          const call = node.type === "assignment" ? node.childForFieldName("right") : null;
          if (call?.type !== "call") continue;
          const callee = py.externalCallee(f.path, call);
          const kind = callee && spec.apps.includes(callee) ? "app" : callee && spec.routers.includes(callee) ? "router" : null;
          if (!kind) continue;
          const id = `${f.path}#${name}`;
          const prefixNode = kind === "router" ? pyArg(call, null, spec.ownPrefix) : null;
          const own = prefixNode === null ? "" : plainString(prefixNode);
          // The same name assigned twice in one file could be either object.
          routers.set(id, { id, kind, own, ambiguous: (f.defs.get(name)?.length ?? 0) > 1 });
          if (kind === "app") appFiles.add(f.path);
        }
      }
    }

    const routerOf = (file: string, node: SyntaxNode | null): Router | null => {
      if (!node) return null;
      const t = py.resolve(file, node);
      return t && t.name !== null ? routers.get(`${t.file}#${t.name}`) ?? null : null;
    };

    const declare = (file: string, router: Router, methods: HttpMethod[], pathNode: SyntaxNode | null, line: number, at: SyntaxNode) => {
      const where = `${file}:${line}`;
      const path = pathNode === null ? null : plainString(pathNode);
      if (path === null) return withheld.add("path isn't a plain string", where);
      if (pyConditional(at)) return withheld.add("declared inside a condition or loop, so whether it exists depends on running the code", where);
      if (router.ambiguous) return withheld.add("its router's name is assigned more than once in its file", where);
      let full = path;
      if (spec.prefixAt === "declaration") {
        if (router.own === null) return withheld.add("its router's own prefix isn't written literally", where);
        full = router.own + path;
      }
      routeFiles.add(file);
      for (const method of methods) declared.push({ router: router.id, method, path: full, file, line });
    };

    const methodsOf = (call: SyntaxNode, where: string): HttpMethod[] | null => {
      if (!pyHasKeyword(call, "methods")) return ["GET"];
      const listed = pyStrings(pyArg(call, null, "methods"));
      if (listed === null) {
        withheld.add("methods aren't a plain list of strings", where);
        return null;
      }
      const out: HttpMethod[] = [];
      for (const m of listed) {
        const method = LOWER.get(m.toLowerCase());
        if (!method) {
          withheld.add(`method ${m} isn't one the route table carries`, where);
          continue;
        }
        if (!out.includes(method)) out.push(method);
      }
      return out;
    };

    for (const f of files) {
      for (const call of f.root.descendantsOfType("call")) {
        const fn = call.childForFieldName("function");
        if (fn?.type !== "attribute") continue;
        const attr = fn.childForFieldName("attribute")?.text ?? "";
        const object = fn.childForFieldName("object");
        const line = call.startPosition.row + 1;
        const where = `${f.path}:${line}`;

        const decorator = spec.decorators.get(attr);
        if (decorator !== undefined && call.parent?.type === "decorator") {
          const router = routerOf(f.path, object);
          if (!router) {
            // Only worth saying in a file that uses the framework: elsewhere
            // `@cache.get(...)` is just some other decorator.
            if ([...f.bindings.values()].some((b) => "external" in b && b.external.split(".")[0] === spec.module)) {
              withheld.add("the object this route is declared on couldn't be traced to where it's created", where);
            }
            continue;
          }
          const methods = decorator === "keyword" ? methodsOf(call, where) : [decorator];
          if (methods) declare(f.path, router, methods, pyArg(call, 0, spec.pathKeyword), line, call);
          continue;
        }

        if (attr === spec.addRoute.name) {
          const router = routerOf(f.path, object);
          if (!router) continue;
          const view = pyArg(call, spec.addRoute.viewArg.index, spec.addRoute.viewArg.keyword);
          const viewFn = view?.type === "call" ? view.childForFieldName("function") : null;
          if (viewFn?.type === "attribute" && viewFn.childForFieldName("attribute")?.text === "as_view") {
            withheld.add("class-based view: its methods come from the class, which isn't read", where);
            continue;
          }
          const methods = methodsOf(call, where);
          if (methods) declare(f.path, router, methods, pyArg(call, 0, spec.pathKeyword), line, call);
          continue;
        }

        if (attr === spec.mount.name || (spec.subApp !== null && attr === spec.subApp)) {
          const parent = routerOf(f.path, object);
          if (!parent) continue;
          const sub = attr === spec.subApp;
          const child = routerOf(f.path, pyArg(call, sub ? 1 : 0, sub ? "app" : null));
          if (!child) continue;
          const conditional = pyConditional(call);
          let prefix: string | null;
          let why: string | undefined;
          const written = sub ? pyArg(call, 0, "path") : pyHasKeyword(call, spec.mount.prefixKeyword) ? pyArg(call, null, spec.mount.prefixKeyword) : null;
          if (written !== null) prefix = plainString(written);
          else if (spec.prefixAt === "mount") prefix = child.own;
          else prefix = "";
          if (prefix === null) why = "a router it sits in is mounted with a prefix that isn't written literally";
          if (conditional) {
            prefix = null;
            why = "a router it sits in is mounted inside a condition or loop";
          }
          mounts.push({ child: child.id, parent: parent.id, prefix, why, where });
        }
      }
    }
  } finally {
    py.done();
  }

  const apps = new Set([...routers.values()].filter((r) => r.kind === "app").map((r) => r.id));
  const found = resolveMounts({ apps, mounts, declared }, spec.join, withheld.add);
  const routes: FoundRoute[] = [];
  for (const r of found) {
    if (!r.path.startsWith("/")) withheld.add("the full path doesn't start with /, which the framework would reject", `${r.file}:${r.line}`);
    else routes.push(r);
  }
  return { routes, withheld: withheld.list(), routeFiles, appFiles };
}
