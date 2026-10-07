import type { Adapter, FoundRoute } from "../adapter.ts";
import { parseIsolated, type DataNode } from "../languages/isolated.ts";
import type { HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { conventionRole, manifestsDeclaring, withheldList } from "./shared.ts";

// Vapor routes are calls with their path as separate components:
// app.get("users", ":id") is /users/:id. Groups made with grouped() or
// group() add components in front, and a RouteCollection's boot(routes:)
// receives whatever it was registered on. The Swift grammar runs in its own
// process (see isolated.ts); if that process fails, every route is withheld
// with its reason.

const VERBS = new Map<string, HttpMethod>([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"]]);
const ENUM_METHODS = new Map<string, HttpMethod>([
  [".GET", "GET"], [".POST", "POST"], [".PUT", "PUT"], [".PATCH", "PATCH"], [".DELETE", "DELETE"], [".HEAD", "HEAD"], [".OPTIONS", "OPTIONS"],
]);

const FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["controller", ["Controllers"]],
  ["middleware", ["Middleware", "Middlewares"]],
  ["migration", ["Migrations"]],
  ["model", ["Models"]],
  ["dto", ["DTOs", "DTO"]],
];

/** A path component as Vapor reads it: "users", ":id", "*", "**", or an enum case. Null if computed. */
function component(n: DataNode): string | null {
  if (n.type === "line_string_literal") {
    if (n.namedChildren.some((c) => c.type !== "line_str_text")) return null;
    const s = n.namedChildren.map((c) => c.text).join("");
    // "a/b" is one component that can never match a request; not read.
    return s.includes("/") ? null : s;
  }
  const t = n.text.replace(/\s/g, "");
  if (t === ".anything") return "*";
  if (t === ".catchall") return "**";
  const m = /^\.(parameter|constant)\("([^"\\]*)"\)$/.exec(t);
  if (m) return m[1] === "parameter" ? `:${m[2]}` : m[2];
  return null;
}

type Arg = { label: string | null; value: DataNode };

function callParts(call: DataNode): { target: DataNode | null; name: string; args: Arg[]; closure: DataNode | null } | null {
  const callee = call.namedChildren[0];
  const suffix = call.namedChildren.find((c) => c.type === "call_suffix");
  if (!callee || !suffix) return null;
  let target: DataNode | null = null;
  let name: string;
  if (callee.type === "navigation_expression") {
    target = callee.childForFieldName("target");
    name = callee.childForFieldName("suffix")?.childForFieldName("suffix")?.text ?? "";
  } else if (callee.type === "simple_identifier") name = callee.text;
  else return null;
  const args = (suffix.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? []).map((a) => ({
    label: a.childForFieldName("name")?.text ?? null,
    value: a.childForFieldName("value") ?? a.namedChildren[a.namedChildren.length - 1],
  }));
  return { target, name, args, closure: suffix.namedChildren.find((c) => c.type === "lambda_literal") ?? null };
}

export const vapor: Adapter = {
  name: "vapor",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)Package\.swift$/.test(p), (t) => /vapor\/vapor/.test(t)),
  reads: (path) => path.endsWith(".swift"),

  async analyze(scope) {
    const w = withheldList();
    const roles = new Map<string, string>();
    const sources = scope.owned
      .map((f) => ({ path: f.path, text: scope.read(f.path) ?? "" }))
      .filter((s) => /\.(get|post|put|patch|delete|on|grouped|group|register)\(/.test(s.text));
    const parsed = await parseIsolated("swift", sources);
    if ("error" in parsed) {
      for (const s of sources) w.add(`Swift couldn't be parsed: ${parsed.error}`, s.path);
      for (const f of scope.owned) {
        const role = conventionRole(f.path, FOLDERS);
        if (role) roles.set(f.path, role);
      }
      return { roles, routes: [], routesWithheld: w.list() };
    }

    const declared: Declared[] = [];
    const mounts: Mount[] = [];
    const apps = new Set<string>();
    const routerFiles = new Set<string>();
    const controllerFiles = new Set<string>();

    // RouteCollections by class name: their boot(routes:) parameter is a router.
    const collections = new Map<string, string[]>();
    for (const [path, root] of parsed.trees) {
      for (const cls of root.descendantsOfType("class_declaration")) {
        if (!cls.namedChildren.some((c) => c.type === "inheritance_specifier" && /RouteCollection/.test(c.text))) continue;
        const name = cls.namedChildren.find((c) => c.type === "type_identifier")?.text;
        const boot = cls.descendantsOfType("function_declaration").find((f) => f.childForFieldName("name")?.text === "boot");
        const param = boot?.namedChildren.find((c) => c.type === "parameter");
        const local = param?.namedChildren.filter((c) => c.type === "simple_identifier").pop()?.text;
        if (name && boot && local) {
          collections.set(name, [...(collections.get(name) ?? []), `${path}@F${boot.startIndex}:${local}`]);
          controllerFiles.add(path);
        }
      }
    }

    for (const [path, root] of parsed.trees) {
      if (root.hasError) {
        w.add("file has Swift syntax the available grammar can't fully read, so its routes aren't trusted", path);
        continue;
      }

      /** The router a name or expression is. */
      const routerOf = (node: DataNode | null | undefined, depth = 0): string | null => {
        if (!node || depth > 12) return null;
        if (node.type === "simple_identifier") {
          for (let p = node.parent; p; p = p.parent) {
            if (p.type === "lambda_literal" && p.descendantsOfType("lambda_parameter").some((x) => x.text.split(":")[0].trim() === node.text)) {
              return `${path}@L${p.startIndex}:${node.text}`;
            }
            if (p.type === "function_declaration") {
              const param = p.namedChildren.find((c) => c.type === "parameter" && c.namedChildren.filter((x) => x.type === "simple_identifier").pop()?.text === node.text);
              if (param) {
                const id = `${path}@F${p.startIndex}:${node.text}`;
                if (/\bApplication\b/.test(param.namedChildren.find((c) => c.type === "user_type")?.text ?? "")) apps.add(id);
                return id;
              }
            }
            const decl = p.namedChildren.find((c) => c.type === "property_declaration" && c.startIndex < node.startIndex && c.childForFieldName("name")?.text === node.text);
            if (decl) return routerOf(decl.childForFieldName("value"), depth + 1);
          }
          return null;
        }
        if (node.type === "call_expression") {
          const c = callParts(node);
          if (c?.name !== "grouped") return null;
          const parent = routerOf(c.target, depth + 1);
          if (!parent) return null;
          const id = `${path}@${node.startIndex}`;
          // grouped(SomeMiddleware()) adds no path; strings and path components do.
          const comps = c.args.filter((a) => a.value.type !== "call_expression").map((a) => component(a.value));
          const prefix = comps.some((x) => x === null) ? null : `/${comps.join("/")}`;
          mounts.push({ child: id, parent, prefix: prefix === "/" ? "" : prefix, where: `${path}:${node.startPosition.row + 1}` });
          return id;
        }
        if (node.type === "try_expression") return routerOf(node.namedChildren[node.namedChildren.length - 1], depth + 1);
        return null;
      };

      for (const call of root.descendantsOfType("call_expression")) {
        const c = callParts(call);
        if (!c || !c.target) continue;
        const line = call.startPosition.row + 1;
        const where = `${path}:${line}`;
        const verb = VERBS.get(c.name);
        const isOn = c.name === "on";
        if (verb || isOn) {
          const receiver = routerOf(c.target);
          if (!receiver) continue;
          let method = verb;
          let args = c.args.filter((a) => a.label === null);
          if (isOn) {
            method = ENUM_METHODS.get(args[0]?.value.text.replace(/\s/g, "") ?? "");
            args = args.slice(1);
            if (!method) {
              w.add("on()'s method isn't a plain .GET-style case", where);
              continue;
            }
          }
          if (!c.closure && !c.args.some((a) => a.label === "use")) continue;
          const comps = args.map((a) => component(a.value));
          if (comps.some((x) => x === null) || !method) {
            w.add("route path components aren't plain strings", where);
            continue;
          }
          routerFiles.add(path);
          declared.push({ router: receiver, method, path: `/${comps.join("/")}`, file: path, line });
          continue;
        }
        if (c.name === "group" && c.closure) {
          const receiver = routerOf(c.target);
          const param = c.closure.descendantsOfType("lambda_parameter")[0]?.text.split(":")[0].trim();
          if (!receiver || !param) continue;
          const comps = c.args.filter((a) => a.value.type !== "call_expression").map((a) => component(a.value));
          const prefix = comps.some((x) => x === null) ? null : `/${comps.join("/")}`;
          mounts.push({ child: `${path}@L${c.closure.startIndex}:${param}`, parent: receiver, prefix: prefix === "/" ? "" : prefix, where });
          continue;
        }
        if (c.name === "register") {
          const receiver = routerOf(c.target);
          const arg = c.args.find((a) => a.label === "collection")?.value;
          const typeName = arg?.type === "call_expression" ? arg.namedChildren[0]?.text : null;
          const targets = typeName ? collections.get(typeName) ?? [] : [];
          if (!receiver) continue;
          if (targets.length !== 1) w.add("a registered RouteCollection couldn't be traced to one class", where);
          else mounts.push({ child: targets[0], parent: receiver, prefix: "", where });
        }
      }
    }

    const join = (prefix: string, p: string) => (prefix === "" ? p : p === "/" ? prefix : prefix + p);
    const routes: FoundRoute[] = resolveMounts({ apps, mounts, declared }, join, w.add);
    for (const f of scope.owned) {
      const role = controllerFiles.has(f.path) ? "controller" : routerFiles.has(f.path) ? "router" : conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes, routesWithheld: w.list() };
  },
};
