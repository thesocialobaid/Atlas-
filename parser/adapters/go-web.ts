import { posix } from "node:path";
import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { conventionRole, manifestsDeclaring, mentions, plainString, withheldList } from "./shared.ts";
import type { ServerRole } from "./taxonomy.ts";

// Go routers are values: an engine or router is created, groups hang off it,
// and handlers are registered with calls. Each variable that holds a router
// is followed within its function; a router handed to another function is
// followed to that function's parameter when the call names a package
// function directly (same package, or through an import the parser
// resolved). A router reached any other way — through a method on some
// struct, stored in a field — can't be tied to its prefix and is withheld.

type GoSpec = {
  name: string;
  /** Module path the go.mod requires. */
  module: string;
  /** Package-qualified constructors: of an application, and of a router that's only a root once served. */
  apps: readonly string[];
  routers: readonly string[];
  /** Type names a function parameter holding a router is declared with. */
  types: readonly string[];
  /** Method name on a router to the HTTP method it registers. */
  verbs: ReadonlyMap<string, HttpMethod>;
  /** Registration where the method is the first argument: Handle, Add, Method. */
  explicit: readonly string[];
  /** Registrations that answer every method. */
  any: readonly string[];
  /** Group(prefix) returning a router; Route(prefix, func(r)); Mount(prefix, router). */
  group: string | null;
  route: string | null;
  mount: string | null;
  /** Calls returning the same router with middleware attached: chi's With, Use chains. */
  same: readonly string[];
  join(prefix: string, path: string): string | null;
  /** The framework's treatment of a path registered straight on the application. */
  root(path: string): string | null;
};

// path.Clean, as Gin's joinPaths uses it.
function clean(p: string): string {
  const out = posix.normalize(p);
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}

function ginJoin(abs: string, rel: string): string {
  if (rel === "") return abs;
  const final = clean(`${abs}/${rel}`);
  return rel.endsWith("/") && !final.endsWith("/") ? `${final}/` : final;
}

const VERBS_UPPER = new Map(HTTP_METHODS.map((m) => [m as string, m]));
const VERBS_TITLE = new Map(HTTP_METHODS.map((m) => [m[0] + m.slice(1).toLowerCase(), m]));

const SPECS: readonly GoSpec[] = [
  {
    name: "gin",
    module: "github.com/gin-gonic/gin",
    apps: ["gin.Default", "gin.New"],
    routers: [],
    types: ["Engine", "RouterGroup", "IRouter", "IRoutes"],
    verbs: VERBS_UPPER,
    explicit: ["Handle"],
    any: ["Any", "Match"],
    group: "Group",
    route: null,
    mount: null,
    same: ["Use"],
    join: (prefix, path) => ginJoin(prefix, path),
    root: (path) => ginJoin("/", path),
  },
  {
    name: "echo",
    module: "github.com/labstack/echo",
    apps: ["echo.New"],
    routers: [],
    types: ["Echo", "Group"],
    verbs: VERBS_UPPER,
    explicit: ["Add"],
    any: ["Any", "Match"],
    group: "Group",
    route: null,
    mount: null,
    same: [],
    // Echo's Group.Add is prefix + path, and a path without a leading slash gets one.
    join: (prefix, path) => prefix + path,
    root: (path) => (path === "" ? "/" : path.startsWith("/") ? path : `/${path}`),
  },
  {
    name: "chi",
    module: "github.com/go-chi/chi",
    apps: [],
    routers: ["chi.NewRouter", "chi.NewMux"],
    types: ["Router", "Mux"],
    verbs: VERBS_TITLE,
    explicit: ["Method", "MethodFunc"],
    any: ["Handle", "HandleFunc"],
    group: null,
    route: "Route",
    mount: "Mount",
    same: ["With", "Use"],
    // Mount strips its pattern and hands the rest on, so "/" under "/x" is "/x".
    join: (prefix, path) => {
      if (prefix === "") return path;
      if (!prefix.startsWith("/") || !path.startsWith("/")) return null;
      const p = prefix.replace(/\/$/, "");
      return path === "/" ? p || "/" : p + path;
    },
    root: (path) => (path.startsWith("/") ? path : null),
  },
  {
    name: "fiber",
    module: "github.com/gofiber/fiber",
    apps: ["fiber.New"],
    routers: [],
    types: ["App", "Router", "Group"],
    verbs: VERBS_TITLE,
    explicit: ["Add"],
    any: ["All"],
    group: "Group",
    route: "Route",
    mount: "Mount",
    same: ["Use"],
    // Fiber's getGroupPath.
    join: (prefix, path) => (path === "" ? prefix : prefix.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`)),
    root: (path) => (path.startsWith("/") ? path : `/${path}`),
  },
];

const FOLDERS: readonly (readonly [ServerRole, readonly string[]])[] = [
  ["command", ["cmd"]],
  ["handler", ["handler", "handlers", "controller", "controllers"]],
  ["middleware", ["middleware", "middlewares"]],
  ["service", ["service", "services"]],
  ["repository", ["repository", "repositories", "repo", "store", "storage"]],
  ["model", ["model", "models", "entity", "entities", "domain"]],
];

type GoFile = { path: string; dir: string; pkg: string; root: SyntaxNode; imports: Map<string, string> };

/** The id of the function scope a node is in, or of the closure parameter it names. */
function scopeOf(file: string, node: SyntaxNode): string {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "function_declaration" || p.type === "method_declaration") {
      const recv = p.type === "method_declaration" ? p.childForFieldName("receiver")?.text ?? "" : "";
      return `${file}#${recv}${p.childForFieldName("name")?.text ?? "?"}`;
    }
  }
  return `${file}#`;
}

function paramNames(fn: SyntaxNode): { name: string; type: string; index: number }[] {
  const out: { name: string; type: string; index: number }[] = [];
  let index = 0;
  for (const decl of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    const type = decl.childForFieldName("type")?.text ?? "";
    const names = decl.childrenForFieldName("name");
    if (names.length === 0) index++;
    for (const n of names) out.push({ name: n.text, type, index: index++ });
  }
  return out;
}

function makeAdapter(spec: GoSpec): Adapter {
  const typeRe = new RegExp(`\\.(${spec.types.join("|")})$`);
  return {
    name: spec.name,
    claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)go\.mod$/.test(p), (text) => mentions(text, spec.module, /^\s*\/\//)),
    reads: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),

    async analyze(scope: AdapterScope) {
      const withheld = withheldList();
      const declared: Declared[] = [];
      const mounts: Mount[] = [];
      const apps = new Set<string>();
      const routerFiles = new Set<string>();
      const parser = await parserFor("go");
      const trees: { delete(): void }[] = [];

      try {
        const files: GoFile[] = [];
        for (const f of scope.owned) {
          const text = scope.read(f.path);
          if (text === null) continue;
          const tree = parser.parse(text);
          trees.push(tree);
          const pkg = tree.rootNode.namedChildren.find((c) => c.type === "package_clause")?.namedChildren[0]?.text ?? "";
          files.push({ path: f.path, dir: posix.dirname(f.path), pkg, root: tree.rootNode, imports: new Map() });
        }
        const byPath = new Map(files.map((f) => [f.path, f]));

        // Import name to the directory it resolved to, named the way Go names
        // it: the alias if written, else the target package's own clause.
        for (const f of files) {
          for (const spec_ of f.root.descendantsOfType("import_spec")) {
            const path = plainString(spec_.childForFieldName("path"));
            if (path === null) continue;
            const line = spec_.startPosition.row + 1;
            const rec = scope.imports.find((r) => r.from === f.path && r.line === line && r.specifier === path);
            const alias = spec_.childForFieldName("name")?.text;
            if (rec?.outcome === "resolved") {
              const target = byPath.get(rec.to[0]);
              const name = alias ?? target?.pkg;
              if (name) f.imports.set(name, posix.dirname(rec.to[0]));
            } else if (path.startsWith(spec.module)) {
              f.imports.set(alias ?? spec.name, `ext:${spec.name}`);
            }
          }
        }
        const frameworkName = (f: GoFile) => [...f.imports].find(([, dir]) => dir === `ext:${spec.name}`)?.[0] ?? null;

        // Package-level functions by directory and name, with their router parameters and what they return.
        type Fn = { file: GoFile; node: SyntaxNode; params: { name: string; index: number }[]; returns: string | null };
        const functions = new Map<string, Fn[]>();
        for (const f of files) {
          for (const fn of f.root.descendantsOfType("function_declaration")) {
            const name = fn.childForFieldName("name")?.text;
            if (!name) continue;
            const params = paramNames(fn).filter((p) => typeRe.test(p.type.replace(/^\*/, "")));
            const rets = fn.descendantsOfType("return_statement").map((r) => r.namedChildren[0]?.namedChildren[0]);
            const ids = new Set(rets.map((r) => (r?.type === "identifier" ? `${scopeOf(f.path, r)}:${r.text}` : null)));
            const returns = ids.size === 1 && !ids.has(null) ? [...ids][0] : null;
            const key = `${f.dir}\n${name}`;
            functions.set(key, [...(functions.get(key) ?? []), { file: f, node: fn, params, returns }]);
          }
        }
        /** The function a call names: same package by bare name, or another through its import. */
        const callee = (f: GoFile, call: SyntaxNode): Fn | null => {
          const fn = call.childForFieldName("function");
          let key: string | null = null;
          if (fn?.type === "identifier") key = `${f.dir}\n${fn.text}`;
          else if (fn?.type === "selector_expression") {
            const dir = f.imports.get(fn.childForFieldName("operand")?.text ?? "");
            if (dir && !dir.startsWith("ext:")) key = `${dir}\n${fn.childForFieldName("field")?.text}`;
          }
          const found = key ? functions.get(key) ?? [] : [];
          return found.length === 1 ? found[0] : null;
        };

        for (const f of files) {
          const fw = frameworkName(f);

          /** The router an expression evaluates to, as an id; null if it isn't one this follows. */
          const routerOf = (node: SyntaxNode | null | undefined): string | null => {
            if (!node) return null;
            if (node.type === "identifier") {
              // A closure's parameter (chi's Route callback) shadows everything outside.
              for (let p = node.parent; p; p = p.parent) {
                if (p.type === "func_literal" && paramNames(p).some((x) => x.name === node.text)) return `${f.path}@${p.startIndex}:${node.text}`;
              }
              return `${scopeOf(f.path, node)}:${node.text}`;
            }
            if (node.type === "call_expression") {
              const fn = node.childForFieldName("function");
              const member = fn?.type === "selector_expression" ? fn.childForFieldName("field")?.text ?? "" : "";
              if (spec.same.includes(member)) return routerOf(fn?.childForFieldName("operand"));
              if (member === spec.group) return `${f.path}@${node.startIndex}`;
              const target = callee(f, node);
              return target?.returns ?? null;
            }
            return null;
          };

          // http.Server{Handler: r} serves it too.
          for (const el of f.root.descendantsOfType("keyed_element")) {
            if (el.namedChildren[0]?.text !== "Handler") continue;
            const value = el.namedChildren[1];
            const id = routerOf(value?.type === "literal_element" ? value.namedChildren[0] : value);
            if (id) apps.add(id);
          }

          for (const call of f.root.descendantsOfType("call_expression")) {
            const fn = call.childForFieldName("function");
            const args = call.childForFieldName("arguments")?.namedChildren ?? [];
            // In a chain the call starts where the chain does; its own line is its method name's.
            const line = (fn?.type === "selector_expression" ? fn.childForFieldName("field") ?? call : call).startPosition.row + 1;
            const where = `${f.path}:${line}`;

            // Constructors: `r := gin.Default()`.
            if (fn?.type === "selector_expression" && fw !== null && fn.childForFieldName("operand")?.text === fw) {
              const qualified = `${spec.name}.${fn.childForFieldName("field")?.text}`;
              const isApp = spec.apps.includes(qualified);
              if (isApp || spec.routers.includes(qualified)) {
                const holder = call.parent?.parent;
                const left = holder?.type === "short_var_declaration" || holder?.type === "assignment_statement" ? holder.childForFieldName("left")?.namedChildren[0] : holder?.type === "var_spec" ? holder.childForFieldName("name") : null;
                const id = left ? routerOf(left) : null;
                if (id && isApp) apps.add(id);
              }
              continue;
            }

            // Serving a chi router makes it the root: http.ListenAndServe(addr, r), http.Server{Handler: r}.
            if (fn?.type === "selector_expression" && /^ListenAndServe(TLS)?$/.test(fn.childForFieldName("field")?.text ?? "")) {
              const handler = args[fn.childForFieldName("field")?.text === "ListenAndServeTLS" ? 3 : 1];
              const id = routerOf(handler);
              if (id) apps.add(id);
              continue;
            }

            if (fn?.type === "selector_expression") {
              const member = fn.childForFieldName("field")?.text ?? "";
              const receiver = routerOf(fn.childForFieldName("operand"));
              if (!receiver) continue;

              const verb = spec.verbs.get(member);
              const explicit = spec.explicit.includes(member);
              if (verb || explicit) {
                let method: HttpMethod | undefined = verb;
                let pathArg = args[0];
                if (explicit) {
                  const m = plainString(args[0]);
                  method = m === null ? undefined : VERBS_UPPER.get(m.toUpperCase());
                  pathArg = args[1];
                  if (!method) {
                    withheld.add(`${member}'s method isn't a plain string the route table carries`, where);
                    continue;
                  }
                }
                const path = plainString(pathArg);
                if (path === null) withheld.add("path isn't a plain string", where);
                else if (method) {
                  declared.push({ router: receiver, method, path, file: f.path, line });
                  routerFiles.add(f.path);
                }
                continue;
              }
              if (spec.any.includes(member)) {
                withheld.add(`${member}() answers every method, or a list this doesn't read`, where);
                continue;
              }
              if (member === spec.group && spec.group !== null) {
                const prefix = plainString(args[0]);
                const holder = call.parent?.parent;
                const left = holder?.type === "short_var_declaration" || holder?.type === "assignment_statement" ? holder.childForFieldName("left")?.namedChildren[0] : null;
                const child = left ? routerOf(left) : `${f.path}@${call.startIndex}`;
                // chi's Group(fn) takes no prefix: its callback's router is the same router.
                if (child) mounts.push({ child, parent: receiver, prefix, where });
                continue;
              }
              if ((member === spec.route || (member === "Group" && spec.name === "chi")) && args.some((a) => a.type === "func_literal")) {
                const cb = args.find((a) => a.type === "func_literal")!;
                const param = paramNames(cb)[0]?.name;
                const prefix = member === "Group" ? "" : plainString(args[0]);
                if (param) mounts.push({ child: `${f.path}@${cb.startIndex}:${param}`, parent: receiver, prefix, where });
                continue;
              }
              if (member === spec.mount && spec.mount !== null) {
                const child = routerOf(args[1]);
                if (!child) withheld.add("a router mounted here couldn't be traced to where it's built", where);
                else mounts.push({ child, parent: receiver, prefix: plainString(args[0]), where });
                continue;
              }
            }

            // A router handed to a package function: its parameter is that router.
            const target = callee(f, call);
            if (target && target.params.length > 0) {
              for (const p of target.params) {
                const given = routerOf(args[p.index]);
                const child = `${scopeOf(target.file.path, target.node.childForFieldName("body") ?? target.node)}:${p.name}`;
                if (given) mounts.push({ child, parent: given, prefix: "", where });
              }
            }
          }
        }
      } finally {
        for (const t of trees) t.delete();
        parser.delete();
      }

      // Gin, Echo and Fiber apps are roots by construction; a chi router only once it's served.
      const found = resolveMounts({ apps, mounts, declared }, spec.join, withheld.add);
      const routes: FoundRoute[] = [];
      for (const r of found) {
        const path = spec.root(r.path);
        if (path === null || !path.startsWith("/")) withheld.add("path doesn't start with /, which the router rejects", `${r.file}:${r.line}`);
        else routes.push({ ...r, path });
      }

      const roles = new Map<string, string>();
      for (const f of scope.owned) {
        const role = routerFiles.has(f.path) ? "router" : /_?handlers?\.go$/.test(f.path) ? "handler" : /_?middleware\.go$/.test(f.path) ? "middleware" : conventionRole(f.path, FOLDERS);
        if (role) roles.set(f.path, role);
      }
      return { roles, routes, routesWithheld: withheld.list() };
    },
  };
}

export const [gin, echo, chi, fiber] = SPECS.map(makeAdapter);
