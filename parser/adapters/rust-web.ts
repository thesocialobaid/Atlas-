import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { conventionRole, manifestsDeclaring, plainString, withheldList } from "./shared.ts";
import type { ServerRole } from "./taxonomy.ts";

// Actix and Axum both build an application as a chain of builder calls:
// App::new().service(...) or Router::new().route(...).nest(...). A chain's
// first call is its router; every call after it hands the same router on.
// Paths into other files go through the module tree the parser built from
// `mod` declarations, and through `use` paths that resolve within it.
// Anything else — a `pub use` re-export, a value from a trait method — isn't
// followed, and routes behind it are withheld.

const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

const FOLDERS: readonly (readonly [ServerRole, readonly string[]])[] = [
  ["handler", ["handler", "handlers", "routes", "api"]],
  ["middleware", ["middleware", "middlewares"]],
  ["service", ["service", "services"]],
  ["repository", ["repository", "repositories", "repo", "db", "store"]],
  ["model", ["model", "models", "entity", "entities", "domain"]],
  ["command", ["bin"]],
];

type RsFile = { path: string; root: SyntaxNode };

export type Project = {
  files: Map<string, RsFile>;
  /** The function an expression names (`list`, `users::list`, `crate::api::list`): its file and name. */
  item(file: string, node: SyntaxNode): { file: string; name: string } | null;
  /** The same, from a path written as text: ["users", "list"]. */
  itemPath(file: string, segments: readonly string[]): { file: string; name: string } | null;
  fn(file: string, name: string): SyntaxNode | null;
};

export async function rustProject(scope: AdapterScope): Promise<Project & { done(): void }> {
  const parser = await parserFor("rust");
  const trees: { delete(): void }[] = [];
  const files = new Map<string, RsFile>();
  for (const f of scope.owned) {
    const text = scope.read(f.path);
    if (text === null) continue;
    const tree = parser.parse(text);
    trees.push(tree);
    files.set(f.path, { path: f.path, root: tree.rootNode });
  }

  // The module tree: `mod users;` in a file is the child file the parser resolved.
  const children = new Map<string, Map<string, string>>();
  const parent = new Map<string, string>();
  for (const r of scope.imports) {
    if (r.kind !== "module-declaration" || r.outcome !== "resolved") continue;
    const m = children.get(r.from) ?? new Map<string, string>();
    m.set(r.specifier, r.to[0]);
    children.set(r.from, m);
    parent.set(r.to[0], r.from);
  }
  const crateRoot = (file: string) => {
    let f = file;
    for (let i = 0; i < 64 && parent.has(f); i++) f = parent.get(f)!;
    return f;
  };
  const moduleAt = (file: string, segments: readonly string[]): string | null => {
    let at = file;
    for (const [i, s] of segments.entries()) {
      if (s === "crate" && i === 0) at = crateRoot(file);
      else if (s === "self") continue;
      else if (s === "super") {
        const up = parent.get(at);
        if (!up) return null;
        at = up;
      } else {
        const next = children.get(at)?.get(s);
        if (!next) return null;
        at = next;
      }
    }
    return at;
  };

  // `use` bindings: last name to the path it stands for.
  const uses = new Map<string, Map<string, string[]>>();
  const usesOf = (file: string) => {
    let map = uses.get(file);
    if (map) return map;
    map = new Map();
    const add = (prefix: string[], node: SyntaxNode) => {
      if (node.type === "identifier") map!.set(node.text, [...prefix, node.text]);
      else if (node.type === "scoped_identifier") {
        const segs = node.text.split("::");
        map!.set(segs[segs.length - 1], [...prefix, ...segs]);
      } else if (node.type === "use_as_clause") {
        const path = node.childForFieldName("path")?.text.split("::") ?? [];
        const alias = node.childForFieldName("alias")?.text;
        if (alias) map!.set(alias, [...prefix, ...path]);
      } else if (node.type === "scoped_use_list") {
        const base = node.childForFieldName("path")?.text.split("::") ?? [];
        for (const c of node.childForFieldName("list")?.namedChildren ?? []) add([...prefix, ...base], c);
      }
    };
    for (const u of files.get(file)?.root.descendantsOfType("use_declaration") ?? []) {
      const arg = u.childForFieldName("argument");
      if (arg) add([], arg);
    }
    uses.set(file, map);
    return map;
  };

  const fn = (file: string, name: string): SyntaxNode | null => {
    const found = (files.get(file)?.root.namedChildren ?? []).filter(
      (c) => c.type === "function_item" && c.childForFieldName("name")?.text === name,
    );
    return found.length === 1 ? found[0] : null;
  };

  const item = (file: string, node: SyntaxNode): { file: string; name: string } | null =>
    node.type === "identifier" || node.type === "scoped_identifier" ? itemPath(file, node.text.split("::")) : null;

  const itemPath = (file: string, segs: readonly string[]): { file: string; name: string } | null => {
    if (segs.length === 0) return null;
    const name = segs[segs.length - 1];
    if (segs.length === 1) {
      if (fn(file, name)) return { file, name };
      const used = usesOf(file).get(name);
      if (!used) return null;
      const at = moduleAt(file, used.slice(0, -1));
      return at ? { file: at, name: used[used.length - 1] } : null;
    }
    // users::list where `users` is a module here, or a `use`d one.
    const [head, ...rest] = segs;
    const viaUse = usesOf(file).get(head);
    const start = viaUse ? moduleAt(file, viaUse) : moduleAt(file, [head]);
    const at = start ? moduleAt(start, rest.slice(0, -1)) : null;
    return at ? { file: at, name } : null;
  };

  return {
    files,
    item,
    itemPath,
    fn,
    done() {
      for (const t of trees) t.delete();
      parser.delete();
    },
  };
}

/** The value a function evaluates to: its block's tail expression, or what every `return` returns if that's one thing. */
export function tailOf(fn: SyntaxNode): SyntaxNode | null {
  const body = fn.childForFieldName("body");
  const last = body?.namedChildren[body.namedChildren.length - 1];
  if (last && last.type !== "expression_statement" && last.type !== "let_declaration") return last;
  return null;
}

/** `name(...)` / `a::b::name(...)` function, or the method name of `x.name(...)`. */
function callName(call: SyntaxNode): { kind: "fn" | "method"; name: string; path: string } | null {
  let fnNode = call.childForFieldName("function");
  // Router::<AppState>::new() and friends.
  if (fnNode?.type === "generic_function") fnNode = fnNode.childForFieldName("function");
  if (!fnNode) return null;
  if (fnNode.type === "field_expression") return { kind: "method", name: fnNode.childForFieldName("field")?.text ?? "", path: "" };
  if (fnNode.type === "identifier" || fnNode.type === "scoped_identifier") {
    const segs = fnNode.text.replace(/::<[^>]*>/g, "").split("::");
    return { kind: "fn", name: segs[segs.length - 1], path: segs.slice(0, -1).join("::") };
  }
  return null;
}

type Kind = "actix" | "axum";

function makeAdapter(kind: Kind): Adapter {
  const crate = kind === "actix" ? "actix-web" : "axum";
  // Builder calls that return the same router they're called on.
  const PRESERVE =
    kind === "actix"
      ? new Set(["service", "route", "configure", "wrap", "wrap_fn", "app_data", "data", "default_service", "guard", "external_resource"])
      : new Set(["route", "nest", "merge", "layer", "route_layer", "with_state", "fallback", "fallback_service", "into_make_service", "into_make_service_with_connect_info"]);

  return {
    name: kind,
    claims: (input) =>
      manifestsDeclaring(input, (p) => /(^|\/)Cargo\.toml$/.test(p), (text) => new RegExp(`^\\s*${crate}\\s*=|\\[dependencies\\.${crate}\\]`, "m").test(text)),
    reads: (path) => path.endsWith(".rs"),

    async analyze(scope) {
      const withheld = withheldList();
      const declared: Declared[] = [];
      const mounts: Mount[] = [];
      const apps = new Set<string>();
      const routerFiles = new Set<string>();
      const handlerFiles = new Set<string>();
      const rs = await rustProject(scope);

      try {
        const fnScope = (file: string, node: SyntaxNode) => {
          for (let p = node.parent; p; p = p.parent) {
            if (p.type === "function_item") return `${file}#fn:${p.childForFieldName("name")?.text ?? "?"}@${p.startIndex}`;
            if (p.type === "closure_expression") continue;
          }
          return `${file}#`;
        };

        /** The router an expression is, as an id; null when it isn't one this follows. */
        const routerOf = (file: string, node: SyntaxNode | null | undefined, depth = 0): string | null => {
          if (!node || depth > 16) return null;
          if (node.type === "identifier") {
            // A `let` in the same function, or a parameter of it.
            for (let p = node.parent; p; p = p.parent) {
              if (p.type !== "function_item" && p.type !== "closure_expression") continue;
              const params = p.childForFieldName("parameters")?.namedChildren ?? [];
              if (params.some((x) => x.childForFieldName("pattern")?.text === node.text || x.text === node.text)) {
                return `${fnScope(file, node)}:param:${node.text}`;
              }
              const lets = p.descendantsOfType("let_declaration").filter((l) => l.childForFieldName("pattern")?.text === node.text && l.startIndex < node.startIndex);
              if (lets.length > 0) return routerOf(file, lets[0].childForFieldName("value"), depth + 1);
              if (p.type === "function_item") break;
            }
            return null;
          }
          if (node.type === "reference_expression") return routerOf(file, node.childForFieldName("value"), depth + 1);
          if (node.type !== "call_expression") return null;
          const c = callName(node);
          if (!c) return null;
          if (c.kind === "method") {
            if (PRESERVE.has(c.name)) return routerOf(file, node.childForFieldName("function")?.childForFieldName("value"), depth + 1);
            return null;
          }
          const id = `${file}@${node.startIndex}`;
          if (kind === "actix" && c.name === "new" && /(^|::)App$/.test(c.path)) return id;
          if (kind === "actix" && (c.name === "scope" || c.name === "resource") && /(^|::)web$/.test(c.path)) return id;
          if (kind === "axum" && c.name === "new" && /(^|::)Router(<.*>)?$/.test(c.path)) return id;
          // A function that builds and returns a router.
          const target = rs.item(file, node.childForFieldName("function")!);
          const def = target ? rs.fn(target.file, target.name) : null;
          const tail = def ? tailOf(def) : null;
          return target && tail ? routerOf(target.file, tail, depth + 1) : null;
        };

        /** The call a builder chain starts with: web::scope("/x") in web::scope("/x").service(a).service(b). */
        const chainRoot = (node: SyntaxNode | null): SyntaxNode | null => {
          let at = node;
          while (at?.type === "call_expression") {
            const c = callName(at);
            if (c?.kind !== "method" || !PRESERVE.has(c.name)) return at;
            at = at.childForFieldName("function")?.childForFieldName("value") ?? null;
          }
          return null;
        };

        /** Methods a route expression answers: web::get().to(h) for Actix, get(h).post(h2) for Axum. */
        const methodsOf = (node: SyntaxNode | null | undefined): HttpMethod[] | string => {
          if (!node || node.type !== "call_expression") return "route's method isn't written as a method builder";
          const c = callName(node);
          if (!c) return "route's method isn't written as a method builder";
          if (kind === "actix") {
            if (c.kind === "method" && c.name === "to") return methodsOf(node.childForFieldName("function")?.childForFieldName("value"));
            if (c.kind === "method") return `route uses .${c.name}(), which this doesn't read`;
            const m = LOWER.get(c.name);
            if (m && /(^|::)web$/.test(c.path)) return [m];
            return c.name === "route" ? "web::route() answers every method unless guarded" : "route's method isn't a plain web::<method>()";
          }
          const base = LOWER.get(c.name.replace(/_service$/, ""));
          if (c.kind === "method") {
            if (!base) return `route uses .${c.name}(), which this doesn't read`;
            const rest = methodsOf(node.childForFieldName("function")?.childForFieldName("value"));
            return typeof rest === "string" ? rest : [...rest, base];
          }
          if (base) return [base];
          return c.name === "any" || c.name === "any_service" ? "any() answers every method" : "route's method isn't a plain routing function";
        };

        for (const f of rs.files.values()) {
          // Actix's attribute routes: #[get("/x")] on a handler function.
          if (kind === "actix") {
            for (const fnItem of f.root.namedChildren.filter((c) => c.type === "function_item")) {
              const name = fnItem.childForFieldName("name")?.text;
              for (let a = fnItem.previousNamedSibling; a?.type === "attribute_item"; a = a.previousNamedSibling) {
                const attr = a.namedChildren[0];
                const attrName = attr?.namedChildren[0]?.text ?? "";
                const method = LOWER.get(attrName);
                const where = `${f.path}:${a.startPosition.row + 1}`;
                if (!method && attrName !== "route") continue;
                const tokens = attr?.childForFieldName("arguments")?.namedChildren ?? [];
                const path = plainString(tokens[0]);
                handlerFiles.add(f.path);
                if (path === null) withheld.add("route path isn't a plain string", where);
                else if (method) declared.push({ router: `${f.path}#handler:${name}`, method, path, file: f.path, line: a.startPosition.row + 1 });
                else withheld.add("#[route] lists its methods as arguments, which this doesn't read", where);
              }
            }
          }

          for (const call of f.root.descendantsOfType("call_expression")) {
            const c = callName(call);
            // In a chain the call starts where the chain does; its own line is its method name's.
            const own = call.childForFieldName("function");
            const line = (own?.type === "field_expression" ? own.childForFieldName("field") ?? call : call).startPosition.row + 1;
            const where = `${f.path}:${line}`;
            const args = call.childForFieldName("arguments")?.namedChildren ?? [];
            if (!c) continue;

            if (c.kind === "fn") {
              const id = routerOf(f.path, call);
              if (id === `${f.path}@${call.startIndex}` && kind === "actix" && c.name === "new") apps.add(id);
              // axum::serve(listener, app) serves the router.
              if (kind === "axum" && c.name === "serve") {
                const served = routerOf(f.path, args[1]);
                if (served) apps.add(served);
              }
              continue;
            }

            const receiverNode = call.childForFieldName("function")?.childForFieldName("value");
            if (kind === "axum" && c.name === "serve") {
              const served = routerOf(f.path, args[0]);
              if (served) apps.add(served);
              continue;
            }
            const receiver = routerOf(f.path, receiverNode);
            if (!receiver) continue;

            if (c.name === "route") {
              const resourceRoute = kind === "actix" && args.length === 1;
              const path = resourceRoute ? "" : plainString(args[0]);
              const methods = methodsOf(resourceRoute ? args[0] : args[1]);
              if (path === null) withheld.add("route path isn't a plain string", where);
              else if (typeof methods === "string") withheld.add(methods, where);
              else {
                routerFiles.add(f.path);
                for (const method of methods) declared.push({ router: receiver, method, path, file: f.path, line });
              }
              continue;
            }
            if (kind === "actix" && c.name === "service") {
              const arg = args[0];
              const child = routerOf(f.path, arg);
              if (child) {
                // The scope's or resource's own path is the first argument of the call the chain starts with.
                const root = chainRoot(arg ?? null);
                const rc = root ? callName(root) : null;
                const prefix = rc?.kind === "fn" && (rc.name === "scope" || rc.name === "resource") ? plainString(root!.childForFieldName("arguments")?.namedChildren[0]) : "";
                mounts.push({ child, parent: receiver, prefix, where });
                continue;
              }
              const target = arg && (arg.type === "identifier" || arg.type === "scoped_identifier") ? rs.item(f.path, arg) : null;
              if (target) mounts.push({ child: `${target.file}#handler:${target.name}`, parent: receiver, prefix: "", where });
              else withheld.add("a service registered here couldn't be traced to its handler or scope", where);
              continue;
            }
            if (kind === "actix" && c.name === "configure") {
              const target = args[0] && rs.item(f.path, args[0]);
              const def = target ? rs.fn(target.file, target.name) : null;
              const param = def?.childForFieldName("parameters")?.namedChildren[0]?.childForFieldName("pattern")?.text;
              if (target && def && param) mounts.push({ child: `${target.file}#fn:${target.name}@${def.startIndex}:param:${param}`, parent: receiver, prefix: "", where });
              else withheld.add("a configure() function couldn't be traced", where);
              continue;
            }
            if (kind === "axum" && (c.name === "nest" || c.name === "merge")) {
              const child = routerOf(f.path, c.name === "nest" ? args[1] : args[0]);
              if (!child) withheld.add(`a router passed to ${c.name}() couldn't be traced to where it's built`, where);
              else mounts.push({ child, parent: receiver, prefix: c.name === "nest" ? plainString(args[0]) : "", where });
              continue;
            }
          }
        }
      } finally {
        rs.done();
      }

      // Axum nests by concatenation, and a nested "/" route's trailing slash
      // changed between versions, so that one combination is withheld.
      const join = (prefix: string, path: string): string | null => {
        if (prefix === "") return path;
        if (!prefix.startsWith("/") || prefix.endsWith("/")) return null;
        if (kind === "axum" && path === "/") return null;
        if (path !== "" && !path.startsWith("/")) return null;
        return prefix + path;
      };
      const routes: FoundRoute[] = [];
      for (const r of resolveMounts({ apps, mounts, declared }, join, withheld.add)) {
        if (!r.path.startsWith("/")) withheld.add("path doesn't start with /", `${r.file}:${r.line}`);
        else routes.push(r);
      }

      const roles = new Map<string, string>();
      for (const f of scope.owned) {
        const role = routerFiles.has(f.path) ? "router" : handlerFiles.has(f.path) ? "handler" : conventionRole(f.path, FOLDERS);
        if (role) roles.set(f.path, role);
      }
      return { roles, routes, routesWithheld: withheld.list() };
    },
  };
}

export const actix = makeAdapter("actix");
export const axum = makeAdapter("axum");
