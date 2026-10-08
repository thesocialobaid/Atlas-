import { posix } from "node:path";
import type { Adapter, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { singular } from "./inflect.ts";
import { allDefined, manifestsDeclaring, plainString, withheldList } from "./shared.ts";
import type { LaravelRole } from "./taxonomy.ts";

// Laravel routes live in route files loaded with a prefix: from
// bootstrap/app.php's withRouting() (Laravel 11 on), or from
// RouteServiceProvider (before). A route file nothing is found loading has no
// known prefix, and its routes are withheld. Inside, Route::get and friends
// declare routes, groups and prefix() chains nest them, and
// Route::resource expands to its fixed seven actions.

const VERBS = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

const RESOURCE: readonly [string, HttpMethod[], "collection" | "member", string, boolean][] = [
  ["index", ["GET"], "collection", "", true],
  ["create", ["GET"], "collection", "create", false],
  ["store", ["POST"], "collection", "", true],
  ["show", ["GET"], "member", "", true],
  ["edit", ["GET"], "member", "edit", false],
  ["update", ["PUT", "PATCH"], "member", "", true],
  ["destroy", ["DELETE"], "member", "", true],
];

const ROLES: readonly (readonly [LaravelRole, RegExp])[] = [
  ["routes", /(^|\/)routes\/[^/]+\.php$/],
  ["controller", /(^|\/)app\/Http\/Controllers\//],
  ["request", /(^|\/)app\/Http\/Requests\//],
  ["resource", /(^|\/)app\/Http\/Resources\//],
  ["middleware", /(^|\/)app\/Http\/Middleware\//],
  ["view", /(^|\/)resources\/views\/.*\.php$/],
  ["model", /(^|\/)app\/Models\//],
  ["policy", /(^|\/)app\/Policies\//],
  ["job", /(^|\/)app\/Jobs\//],
  ["event", /(^|\/)app\/Events\//],
  ["listener", /(^|\/)app\/Listeners\//],
  ["mail", /(^|\/)app\/Mail\//],
  ["notification", /(^|\/)app\/Notifications\//],
  ["command", /(^|\/)app\/Console\/Commands\//],
  ["provider", /(^|\/)app\/Providers\//],
  ["migration", /(^|\/)database\/migrations\//],
  ["seeder", /(^|\/)database\/(seeders|factories)\//],
];

/** Laravel trims slashes off each piece and joins with one; an empty uri is "/". */
function joinUri(parts: readonly string[]): string {
  const p = parts.map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${p}`;
}

/** A call chain from its base: Route::prefix('a')->middleware('x')->group(...) as [prefix, middleware, group]. */
function chain(node: SyntaxNode): { base: SyntaxNode; calls: { name: string; args: SyntaxNode[]; node: SyntaxNode }[] } | null {
  const calls: { name: string; args: SyntaxNode[]; node: SyntaxNode }[] = [];
  let at: SyntaxNode | null = node;
  while (at?.type === "member_call_expression") {
    calls.unshift({ name: at.childForFieldName("name")?.text ?? "", args: argList(at), node: at });
    at = at.childForFieldName("object");
  }
  if (at?.type !== "scoped_call_expression") return null;
  const scope = at.childForFieldName("scope")?.text ?? "";
  if (!/(^|\\)Route$/.test(scope)) return null;
  calls.unshift({ name: at.childForFieldName("name")?.text ?? "", args: argList(at), node: at });
  return { base: at, calls };
}

function argList(call: SyntaxNode): SyntaxNode[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type === "argument");
}

const value = (arg: SyntaxNode | undefined) => arg?.namedChildren[arg.namedChildren.length - 1] ?? null;
const argName = (arg: SyntaxNode) => arg.childForFieldName("name")?.text ?? null;

/** ['a', 'b'] as strings; null if anything's computed. */
function strings(node: SyntaxNode | null): string[] | null {
  if (!node || node.type !== "array_creation_expression") return null;
  const out: string[] = [];
  for (const el of node.namedChildren) {
    if (el.namedChildren.length !== 1) return null;
    const s = plainString(el.namedChildren[0]);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** 'key' => value pairs of a literal array. */
function keyed(node: SyntaxNode | null): Map<string, SyntaxNode> | null {
  if (!node || node.type !== "array_creation_expression") return null;
  const out = new Map<string, SyntaxNode>();
  for (const el of node.namedChildren) {
    if (el.namedChildren.length !== 2) return null;
    const k = plainString(el.namedChildren[0]);
    if (k === null) return null;
    out.set(k, el.namedChildren[1]);
  }
  return out;
}

/** A path written as __DIR__.'/../routes/web.php' or base_path('routes/web.php'), relative to the project root. */
function routeFilePath(node: SyntaxNode | null, fileDir: string, root: string): string | null {
  if (!node) return null;
  if (node.type === "binary_expression" && node.namedChildren[0]?.text === "__DIR__") {
    const rest = plainString(node.namedChildren[1]);
    return rest === null ? null : posix.normalize(posix.join(fileDir, rest));
  }
  if (node.type === "function_call_expression" && node.childForFieldName("function")?.text === "base_path") {
    const rel = plainString(value(argList(node)[0]));
    return rel === null ? null : posix.join(root, rel);
  }
  return null;
}

export const laravel: Adapter = {
  name: "laravel",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)composer\.json$/.test(p), (text) => /"laravel\/framework"\s*:/.test(text)),
  reads: (path) => path.endsWith(".php"),

  async analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = ROLES.find(([, re]) => re.test(f.path))?.[0];
      if (role) roles.set(f.path, role);
    }

    const withheld = withheldList();
    const routes: FoundRoute[] = [];
    const parser = await parserFor("php");
    const trees: { delete(): void }[] = [];
    const parse = (rel: string): SyntaxNode | null => {
      const text = scope.read(rel);
      if (text === null) return null;
      const tree = parser.parse(text);
      trees.push(tree);
      return tree.rootNode;
    };

    try {
      for (const root of scope.roots) {
        const base = root ? `${root}/` : "";
        const loaded = new Map<string, string>();
        const loaders: string[] = [];

        // Laravel 11+: ->withRouting(web: ..., api: ..., apiPrefix: 'api', health: '/up').
        const bootstrap = `${base}bootstrap/app.php`;
        const boot = parse(bootstrap);
        for (const call of boot?.descendantsOfType("member_call_expression") ?? []) {
          if (call.childForFieldName("name")?.text !== "withRouting") continue;
          loaders.push(bootstrap);
          const named = new Map(argList(call).map((a) => [argName(a) ?? "", value(a)]));
          const apiPrefix = named.has("apiPrefix") ? plainString(named.get("apiPrefix")!) : "api";
          for (const [key, prefix] of [["web", ""], ["api", apiPrefix]] as const) {
            const target = routeFilePath(named.get(key) ?? null, posix.dirname(bootstrap), root);
            if (target && prefix !== null) loaded.set(target, prefix);
            else if (named.has(key)) withheld.add(`withRouting's ${key}: file or prefix isn't written plainly`, bootstrap);
          }
          const health = named.has("health") ? plainString(named.get("health")!) : null;
          if (health) routes.push({ file: bootstrap, method: "GET", path: joinUri([health]), line: call.startPosition.row + 1 });
        }

        // Before 11: RouteServiceProvider's Route::prefix('api')->group(base_path('routes/api.php')).
        const provider = `${base}app/Providers/RouteServiceProvider.php`;
        const prov = parse(provider);
        for (const stmt of prov?.descendantsOfType("member_call_expression") ?? []) {
          const c = chain(stmt);
          const last = c?.calls[c.calls.length - 1];
          if (!c || last?.node !== stmt || last.name !== "group") continue;
          const target = routeFilePath(value(last.args[0]), posix.dirname(provider), root);
          if (!target) continue;
          loaders.push(provider);
          const prefixes = c.calls.filter((x) => x.name === "prefix").map((x) => plainString(value(x.args[0])));
          const plain = allDefined(prefixes);
          if (plain === null) withheld.add("a route file's prefix isn't written plainly", provider);
          else loaded.set(target, joinUri(plain).slice(1));
        }

        const walk = (file: string, statements: readonly SyntaxNode[], prefix: string[], depth: number) => {
          for (const stmt of statements) {
            const where = `${file}:${stmt.startPosition.row + 1}`;
            if (stmt.type === "if_statement" || stmt.type === "switch_statement" || stmt.type === "foreach_statement" || stmt.type === "for_statement") {
              if (/Route::/.test(stmt.text)) withheld.add("routes declared inside a condition or loop, so whether they exist depends on running the app", where);
              continue;
            }
            const expr = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
            if (!expr) continue;
            const c = chain(expr);
            if (!c) {
              if (/Route::/.test(expr.text)) withheld.add("a Route call this doesn't read", where);
              continue;
            }
            route(file, c, prefix, where, depth);
          }
        };

        const route = (file: string, c: NonNullable<ReturnType<typeof chain>>, prefix: string[], where: string, depth: number) => {
          const head = c.calls[0];
          const line = head.node.startPosition.row + 1;
          let pre = [...prefix];
          // Attribute calls before the terminal one: prefix() adds to the path; the rest don't touch it.
          for (const call of c.calls) {
            if (call.name === "prefix") {
              const p = plainString(value(call.args[0]));
              if (p === null) return withheld.add("prefix isn't a plain string", where);
              pre = [...pre, p];
            }
          }
          const terminal = c.calls.find((x) => ["get", "post", "put", "patch", "delete", "options", "any", "match", "resource", "apiResource", "resources", "apiResources", "group", "view", "redirect", "permanentRedirect", "fallback"].includes(x.name));
          if (!terminal) return withheld.add(`Route::${head.name} chain doesn't declare anything this reads`, where);

          if (terminal.name === "group") {
            let groupPre = pre;
            let body: SyntaxNode | null = null;
            for (const arg of terminal.args) {
              const v = value(arg);
              if (v?.type === "array_creation_expression") {
                const attrs = keyed(v);
                if (!attrs) return withheld.add("group attributes aren't a plain array", where);
                const p = attrs.get("prefix");
                if (p) {
                  const s = plainString(p);
                  if (s === null) return withheld.add("group prefix isn't a plain string", where);
                  groupPre = [...groupPre, s];
                }
              } else body = v;
            }
            if (body?.type === "anonymous_function_creation_expression" || body?.type === "arrow_function") {
              const block = body.childForFieldName("body");
              return walk(file, block?.type === "compound_statement" ? block.namedChildren : [], groupPre, depth);
            }
            const target = routeFilePath(body, posix.dirname(file), root);
            const tree = target && depth < 8 ? parse(target) : null;
            if (target && tree) return walk(target, tree.namedChildren, groupPre, depth + 1);
            return withheld.add("group body isn't a closure or a route file this can read", where);
          }

          const args = terminal.args;
          if (terminal.name === "any" || terminal.name === "redirect" || terminal.name === "permanentRedirect") {
            return withheld.add(`Route::${terminal.name} answers every method`, where);
          }
          if (terminal.name === "fallback") return;
          if (terminal.name === "resources" || terminal.name === "apiResources") {
            return withheld.add(`Route::${terminal.name} with a list of resources isn't read`, where);
          }
          if (terminal.name === "resource" || terminal.name === "apiResource") {
            if (c.calls.some((x) => ["parameters", "parameter", "shallow", "scoped"].includes(x.name))) {
              return withheld.add("resource with renamed parameters or shallow nesting, which this doesn't read", where);
            }
            const name = plainString(value(args[0]));
            if (name === null) return withheld.add("resource name isn't a plain string", where);
            const onlyCall = c.calls.find((x) => x.name === "only");
            const exceptCall = c.calls.find((x) => x.name === "except");
            const only = onlyCall ? strings(value(onlyCall.args[0])) ?? (plainString(value(onlyCall.args[0])) !== null ? [plainString(value(onlyCall.args[0]))!] : null) : undefined;
            const except = exceptCall ? strings(value(exceptCall.args[0])) ?? (plainString(value(exceptCall.args[0])) !== null ? [plainString(value(exceptCall.args[0]))!] : null) : undefined;
            if (only === null || except === null) return withheld.add("only() or except() isn't a plain list", where);
            // 'photos.comments' nests comments under one photo: photos/{photo}/comments.
            const parts = name.split(".");
            const path: string[] = [...pre];
            for (const [i, part] of parts.entries()) {
              const segs = part.split("/");
              path.push(...segs);
              if (i < parts.length - 1) {
                const one = singular(segs[segs.length - 1].replace(/-/g, "_"));
                if (one === null) return withheld.add("nested resource's parameter name can't be worked out", where);
                path.push(`{${one}}`);
              }
            }
            const last = parts[parts.length - 1].split("/").pop()!;
            const param = singular(last.replace(/-/g, "_"));
            for (const [action, verbs, on, suffix, api] of RESOURCE) {
              if (terminal.name === "apiResource" && !api) continue;
              if ((only && !only.includes(action)) || (except && except.includes(action))) continue;
              if (on === "member" && param === null) {
                withheld.add("resource parameter name can't be worked out", where);
                continue;
              }
              const uri = joinUri([...path, ...(on === "member" ? [`{${param}}`] : []), suffix]);
              for (const v of verbs) routes.push({ file, method: v, path: uri, line });
            }
            return;
          }

          let verbs: HttpMethod[];
          let uriArg: SyntaxNode | null;
          if (terminal.name === "match") {
            const listed = strings(value(args[0]));
            const mapped = listed ? allDefined(listed.map((m) => VERBS.get(m.toLowerCase()))) : null;
            if (!mapped) return withheld.add("Route::match's methods aren't a plain list the route table carries", where);
            verbs = mapped;
            uriArg = value(args[1]);
          } else {
            verbs = [terminal.name === "view" ? "GET" : VERBS.get(terminal.name)!];
            uriArg = value(args[0]);
          }
          const uri = plainString(uriArg);
          if (uri === null) return withheld.add("route uri isn't a plain string", where);
          for (const v of verbs) routes.push({ file, method: v, path: joinUri([...pre, uri]), line });
        };

        for (const [file, prefix] of loaded) {
          const tree = parse(file);
          if (tree) walk(file, tree.namedChildren, prefix ? [prefix] : [], 0);
        }
        // Route files nothing was found loading: their prefix isn't known.
        for (const f of scope.owned) {
          if (!/(^|\/)routes\/(web|api)\.php$/.test(f.path) || loaded.has(f.path) || !f.path.startsWith(base)) continue;
          const tree = parse(f.path);
          const count = tree?.descendantsOfType("scoped_call_expression").filter((c) => c.childForFieldName("scope")?.text === "Route").length ?? 0;
          if (count > 0) {
            withheld.add(
              loaders.length === 0 ? "where this route file is loaded isn't found (no withRouting or RouteServiceProvider), so its prefix isn't known" : "this route file isn't loaded by anything found",
              f.path,
              count,
            );
          }
        }
      }
    } finally {
      for (const t of trees) t.delete();
      parser.delete();
    }

    const seen = new Set<string>();
    const unique = routes.filter((r) => {
      const key = `${r.file}\n${r.method}\n${r.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { roles, routes: unique, routesWithheld: withheld.list() };
  },
};
