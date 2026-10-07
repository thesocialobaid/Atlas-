import type { Adapter, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import type { HttpMethod } from "../types.ts";
import { resolveMounts, type Declared, type Mount } from "./mounts.ts";
import { conventionRole, manifestsDeclaring, mentions, plainString, withheldList } from "./shared.ts";
import type { AspnetRole } from "./taxonomy.ts";

// Two ways ASP.NET Core declares routes, both read here. Attribute routing on
// controllers: the controller's [Route] template and the action's verb
// attribute together, with [controller] and [action] replaced by the fixed
// rule (the class name without "Controller", the method name without
// "Async"). And minimal APIs: Map* calls on the app, on groups made with
// MapGroup, and on the builder an extension method is handed — traced back to
// where that method is called. Conventional routes (MapControllerRoute) come
// from a template with defaults, so actions without attributes are withheld.

const VERBS = new Map<string, HttpMethod>([
  ["HttpGet", "GET"], ["HttpPost", "POST"], ["HttpPut", "PUT"], ["HttpPatch", "PATCH"],
  ["HttpDelete", "DELETE"], ["HttpHead", "HEAD"], ["HttpOptions", "OPTIONS"],
]);
const MAPS = new Map<string, HttpMethod>([
  ["MapGet", "GET"], ["MapPost", "POST"], ["MapPut", "PUT"], ["MapPatch", "PATCH"], ["MapDelete", "DELETE"],
]);

const SUFFIXES: readonly (readonly [AspnetRole, RegExp])[] = [
  ["razor page", /(^|\/)Pages\/.*\.cshtml(\.cs)?$/],
  ["controller", /Controller\.cs$/],
  ["hub", /Hub\.cs$/],
  ["endpoint", /Endpoints?\.cs$/],
  ["middleware", /Middleware\.cs$/],
  ["service", /Service\.cs$/],
  ["repository", /Repository\.cs$/],
  ["dto", /(Dto|DTO|Request|Response)\.cs$/],
  ["startup", /(^|\/)(Program|Startup)\.cs$/],
];
const FOLDERS: readonly (readonly [AspnetRole, readonly string[]])[] = [
  ["model", ["Models", "Entities", "Domain"]],
  ["dto", ["Dtos", "DTOs", "Contracts"]],
  ["service", ["Services"]],
  ["repository", ["Repositories"]],
];

/**
 * The grammar predates C# 10, so `namespace X;` reads as an error. Blanking
 * that one line, keeping every offset, lets the rest of the file read as it
 * would inside a block namespace; the declaration itself names no route.
 */
function forGrammar(text: string): string {
  return text.replace(/^([ \t]*)namespace\s+[\w.]+\s*;/m, (m) => " ".repeat(m.length));
}

type Attr = { name: string; args: SyntaxNode[]; line: number };

function attributesOf(node: SyntaxNode): Attr[] {
  const out: Attr[] = [];
  for (const list of node.namedChildren.filter((c) => c.type === "attribute_list")) {
    for (const a of list.namedChildren.filter((c) => c.type === "attribute")) {
      const raw = a.childForFieldName("name")?.text ?? "";
      const name = raw.slice(raw.lastIndexOf(".") + 1).replace(/Attribute$/, "");
      const argList = a.namedChildren.find((c) => c.type === "attribute_argument_list");
      out.push({ name, args: argList?.namedChildren ?? [], line: a.startPosition.row + 1 });
    }
  }
  return out;
}

/** The first positional argument as a plain string; undefined when there's none, null when computed. */
function template(attr: Attr): string | null | undefined {
  const positional = attr.args.filter((a) => !a.namedChildren.some((c) => c.type === "name_equals" || c.type === "assignment_expression"));
  const first = positional[0]?.namedChildren[0];
  if (!first) return undefined;
  return plainString(first);
}

/** Replaces [controller], [action] and [area]; null if a token can't be filled. */
function tokens(t: string, values: Record<string, string | null>): string | null {
  if (t.includes("[[") || t.includes("]]")) return null;
  let ok = true;
  const out = t.replace(/\[(\w+)\]/g, (_, name: string) => {
    const v = values[name.toLowerCase()];
    if (v === undefined || v === null) ok = false;
    return v ?? "";
  });
  return ok ? out : null;
}

/** Controller template and action template combined; "/" or "~/" on the action starts over. */
function combine(controller: string, action: string): string | null {
  const absolute = action.startsWith("/") || action.startsWith("~/");
  const parts = absolute ? [action.replace(/^~?\//, "")] : [controller, action];
  const segs: string[] = [];
  for (const raw of parts) {
    const p = raw.replace(/^\//, "");
    if (p === "") continue;
    if (p.includes("//") || p.endsWith("/")) return null;
    segs.push(p);
  }
  return `/${segs.join("/")}`;
}

export const aspnet: Adapter = {
  name: "aspnet",
  claims: (input) =>
    manifestsDeclaring(
      input,
      (path) => path.endsWith(".csproj"),
      (text) => mentions(text, "Microsoft.NET.Sdk.Web") || mentions(text, "Microsoft.AspNetCore"),
    ),
  reads: (path) => path.endsWith(".cs") || path.endsWith(".cshtml"),

  async analyze(scope) {
    const roles = new Map<string, string>();
    const withheld = withheldList();
    const found: FoundRoute[] = [];
    const declared: Declared[] = [];
    const mounts: Mount[] = [];
    const apps = new Set<string>();
    const endpointFiles = new Set<string>();
    let pathBase: string | null = null;

    for (const f of scope.owned) {
      if (f.path.endsWith(".cshtml") && /^\s*@page\b/m.test(scope.read(f.path) ?? "")) {
        withheld.add("Razor Pages route comes from the @page directive and the folder, which isn't read", f.path);
      }
    }

    const parser = await parserFor("c_sharp");
    const trees: { delete(): void }[] = [];
    try {
      type Parsed = { path: string; root: SyntaxNode; broken: boolean };
      const files: Parsed[] = [];
      for (const f of scope.owned) {
        if (!f.path.endsWith(".cs")) continue;
        const text = scope.read(f.path);
        if (text === null) continue;
        const tree = parser.parse(forGrammar(text));
        trees.push(tree);
        files.push({ path: f.path, root: tree.rootNode, broken: tree.rootNode.hasError });
      }

      // Classes by name, for a [Route] inherited from a base controller.
      const classes = new Map<string, SyntaxNode[]>();
      for (const f of files) {
        for (const c of f.root.descendantsOfType("class_declaration")) {
          const n = c.childForFieldName("name")?.text;
          if (n) classes.set(n, [...(classes.get(n) ?? []), c]);
        }
      }
      const classRoutes = (cls: SyntaxNode, depth: number): Attr[] | null => {
        const own = attributesOf(cls).filter((a) => a.name === "Route");
        if (own.length > 0 || depth > 4) return own;
        const base = cls.childForFieldName("bases")?.namedChildren[0]?.text;
        const parents = base ? classes.get(base) ?? [] : [];
        if (parents.length > 1) return null;
        return parents.length === 1 ? classRoutes(parents[0], depth + 1) : [];
      };

      // Extension methods that take a route builder: `this IEndpointRouteBuilder app`.
      const extensions = new Map<string, string[]>();
      const scopeOf = (path: string, node: SyntaxNode): string => {
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === "method_declaration" || p.type === "local_function_statement") {
            return `${path}#${p.childForFieldName("name")?.text ?? "?"}@${p.startPosition.row}`;
          }
        }
        return `${path}#top`;
      };

      for (const f of files) {
        if (f.root.text.includes("UsePathBase")) pathBase ??= f.path;
        for (const m of f.root.descendantsOfType("method_declaration")) {
          const first = m.childForFieldName("parameters")?.namedChildren[0];
          if (!first || !/^this\s/.test(first.text) || !/RouteBuilder|WebApplication|RouteGroupBuilder/.test(first.text)) continue;
          const name = m.childForFieldName("name")?.text;
          const param = first.childForFieldName("name")?.text;
          if (name && param) extensions.set(name, [...(extensions.get(name) ?? []), `${scopeOf(f.path, m.childForFieldName("body") ?? m)}:${param}`]);
        }
      }

      for (const f of files) {
        const hasRoutes = /\[(Http(Get|Post|Put|Patch|Delete|Head|Options)|Route|AcceptVerbs)\b|\.Map(Get|Post|Put|Patch|Delete|Group|Methods)\s*\(/.test(f.root.text);
        if (f.broken && hasRoutes) {
          // Positions in a tree with errors can't be trusted to mean what they say.
          withheld.add("file uses C# syntax newer than the available grammar can read", f.path);
          continue;
        }

        // Attribute-routed controllers.
        for (const cls of f.root.descendantsOfType("class_declaration")) {
          const name = cls.childForFieldName("name")?.text ?? "";
          const attrs = attributesOf(cls);
          const isController = name.endsWith("Controller") || attrs.some((a) => a.name === "ApiController" || a.name === "Controller");
          const abstract = cls.namedChildren.some((c) => c.type === "modifier" && c.text === "abstract");
          if (!isController || abstract) continue;
          const routeAttrs = classRoutes(cls, 0);
          const area = attrs.find((a) => a.name === "Area");
          const values = {
            controller: name.replace(/Controller$/, ""),
            area: area ? template(area) ?? null : null,
          };
          for (const m of cls.childForFieldName("body")?.namedChildren ?? []) {
            if (m.type !== "method_declaration" || !/\bpublic\b/.test(m.namedChildren.filter((c) => c.type === "modifier").map((c) => c.text).join(" "))) continue;
            const mAttrs = attributesOf(m);
            if (mAttrs.some((a) => a.name === "NonAction")) continue;
            const actionName = mAttrs.find((a) => a.name === "ActionName");
            const action = actionName ? template(actionName) ?? null : (m.childForFieldName("name")?.text ?? "").replace(/Async$/, "");
            const verbs = mAttrs.filter((a) => VERBS.has(a.name) || a.name === "AcceptVerbs");
            const actionRoutes = mAttrs.filter((a) => a.name === "Route");
            const line = (verbs[0] ?? actionRoutes[0])?.line ?? m.startPosition.row + 1;
            const where = `${f.path}:${line}`;
            if (verbs.length === 0) {
              withheld.add(
                routeAttrs !== null && routeAttrs.length === 0 && actionRoutes.length === 0
                  ? "action without route attributes is reached by conventional routing, whose template isn't read"
                  : "action has no HTTP verb attribute, so it answers every method",
                where,
              );
              continue;
            }
            if (routeAttrs === null) {
              withheld.add("the controller's base class name is declared more than once, so its [Route] isn't known", where);
              continue;
            }
            const controllerTemplates: (string | null)[] = routeAttrs.length ? routeAttrs.map((a) => template(a) ?? "") : [""];
            for (const v of verbs) {
              let methods: HttpMethod[];
              let own: (string | null | undefined)[];
              if (v.name === "AcceptVerbs") {
                const listed = v.args.map((a) => plainString(a.namedChildren[0])).filter((s): s is string => s !== null);
                const all = listed.map((s) => [...VERBS.values()].find((h) => h === s.toUpperCase()));
                if (listed.length !== v.args.length || all.some((h) => h === undefined) || listed.length === 0) {
                  withheld.add("[AcceptVerbs] lists methods that aren't plain strings", where);
                  continue;
                }
                methods = all.filter((h): h is HttpMethod => h !== undefined);
                own = actionRoutes.length ? actionRoutes.map((a) => template(a)) : [undefined];
              } else {
                methods = [VERBS.get(v.name)!];
                const t = template(v);
                own = t !== undefined ? [t] : actionRoutes.length ? actionRoutes.map((a) => template(a)) : [undefined];
              }
              for (const ct of controllerTemplates) {
                for (const at of own) {
                  if (ct === null || at === null) {
                    withheld.add("route template isn't a plain string", where);
                    continue;
                  }
                  const raw = combine(ct, at ?? "");
                  const filled = raw === null ? null : tokens(raw, { ...values, action });
                  if (filled === null) {
                    withheld.add("template has a token that can't be filled, or a doubled or trailing slash", where);
                    continue;
                  }
                  for (const method of methods) found.push({ file: f.path, method, path: filled, line });
                }
              }
            }
          }
        }

        // Minimal APIs: variables holding the app or a group, per method body.
        const routerOf = (node: SyntaxNode | null): string | null => {
          if (!node) return null;
          if (node.type === "identifier") return `${scopeOf(f.path, node)}:${node.text}`;
          if (node.type === "invocation_expression") return `${f.path}@${node.startIndex}`;
          return null;
        };
        for (const decl of f.root.descendantsOfType("variable_declarator")) {
          const name = decl.namedChildren[0]?.type === "identifier" ? decl.namedChildren[0].text : null;
          const value = decl.namedChildren.find((c) => c.type === "equals_value_clause")?.namedChildren[0];
          if (!name || value?.type !== "invocation_expression") continue;
          const fn = value.childForFieldName("function");
          if (fn?.type !== "member_access_expression") continue;
          const member = fn.childForFieldName("name")?.text;
          const id = `${scopeOf(f.path, decl)}:${name}`;
          if (member === "Build" && f.root.text.includes("WebApplication")) apps.add(id);
          if (member !== "MapGroup") continue;
          const parent = routerOf(fn.childForFieldName("expression"));
          const where = `${f.path}:${decl.startPosition.row + 1}`;
          const prefix = plainString(value.childForFieldName("arguments")?.namedChildren[0]?.namedChildren[0]);
          if (parent) mounts.push({ child: id, parent, prefix, where });
        }
        for (const call of f.root.descendantsOfType("invocation_expression")) {
          const fn = call.childForFieldName("function");
          if (fn?.type !== "member_access_expression") continue;
          const member = fn.childForFieldName("name")?.text ?? "";
          const receiver = fn.childForFieldName("expression");
          const parent = routerOf(receiver);
          // In a chain the call starts where the chain does; its own line is its method name's.
          const line = (fn.childForFieldName("name") ?? call).startPosition.row + 1;
          const where = `${f.path}:${line}`;
          const args = call.childForFieldName("arguments")?.namedChildren ?? [];
          if (member === "MapGroup" && call.parent?.type !== "equals_value_clause" && parent) {
            mounts.push({ child: `${f.path}@${call.startIndex}`, parent, prefix: plainString(args[0]?.namedChildren[0]), where });
            continue;
          }
          if (member === "MapMethods") {
            withheld.add("MapMethods' list of methods isn't read", where);
            continue;
          }
          const method = MAPS.get(member);
          if (method && parent) {
            const p = plainString(args[0]?.namedChildren[0]);
            if (p === null) withheld.add("route pattern isn't a plain string", where);
            else {
              endpointFiles.add(f.path);
              declared.push({ router: parent, method, path: `/${p.replace(/^\//, "")}`, file: f.path, line });
            }
            continue;
          }
          const targets = extensions.get(member);
          if (targets && parent) {
            if (targets.length > 1) withheld.add(`extension method ${member} is declared more than once, so which one this calls isn't known`, where);
            else mounts.push({ child: targets[0], parent, prefix: "", where });
          }
        }
      }
    } finally {
      for (const t of trees) t.delete();
      parser.delete();
    }

    // A group's own root ("/" under MapGroup) may or may not answer with a
    // trailing slash depending on version; that combination is withheld.
    const minimal = resolveMounts({ apps, mounts, declared }, (prefix, path) => {
      if (prefix === "") return path;
      const pre = prefix.replace(/^\//, "");
      if (pre.endsWith("/") || pre.includes("//") || path === "/") return null;
      return `/${pre}${path}`;
    }, withheld.add);

    const routes: FoundRoute[] = [];
    for (const r of [...found, ...minimal]) {
      if (pathBase !== null) withheld.add(`no full pattern is known: UsePathBase is called (${pathBase}), which this doesn't read`, `${r.file}:${r.line}`);
      else routes.push(r);
    }

    for (const f of scope.owned) {
      const role = endpointFiles.has(f.path) && !/(Program|Startup)\.cs$/.test(f.path)
        ? "endpoint"
        : SUFFIXES.find(([, re]) => re.test(f.path))?.[0] ?? conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes, routesWithheld: withheld.list() };
  },
};
