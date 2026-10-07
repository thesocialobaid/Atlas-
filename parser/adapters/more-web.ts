import type { Adapter, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { rustProject, tailOf } from "./rust-web.ts";
import { allDefined, conventionRole, manifestsDeclaring, plainString, withheldList } from "./shared.ts";

const UPPER = new Map(HTTP_METHODS.map((m) => [m as string, m]));
const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

// ------------------------------------------------------------------ Symfony

// A Symfony route is the class's #[Route] prefix and the method's #[Route]
// path, concatenated exactly as written (Symfony adds no slash between), with
// the methods its `methods:` lists. A route without `methods:` answers every
// method. The YAML import that loads the controllers may put a plain prefix
// in front; a prefix per locale or per environment withholds them instead.

const SYMFONY_ROLES: readonly (readonly [string, RegExp])[] = [
  ["controller", /(^|\/)src\/Controller\//],
  ["entity", /(^|\/)src\/Entity\//],
  ["repository", /(^|\/)src\/Repository\//],
  ["form", /(^|\/)src\/Form\//],
  ["command", /(^|\/)src\/Command\//],
  ["listener", /(^|\/)src\/(EventSubscriber|EventListener|MessageHandler)\//],
  ["security", /(^|\/)src\/Security\//],
  ["service", /(^|\/)src\/Service\//],
  ["template", /(^|\/)templates\/.*\.twig$/],
  ["migration", /(^|\/)migrations\//],
];

type PhpAttr = { line: number; positional: SyntaxNode[]; named: Map<string, SyntaxNode> };

function routeAttrs(node: SyntaxNode): PhpAttr[] {
  const out: PhpAttr[] = [];
  const list = node.childForFieldName("attributes");
  for (const group of list?.namedChildren ?? []) {
    for (const a of group.namedChildren.filter((x) => x.type === "attribute")) {
      const name = a.namedChildren.find((x) => x.type === "name" || x.type === "qualified_name")?.text ?? "";
      if (name.slice(name.lastIndexOf("\\") + 1) !== "Route") continue;
      const positional: SyntaxNode[] = [];
      const named = new Map<string, SyntaxNode>();
      for (const arg of a.childForFieldName("parameters")?.namedChildren ?? []) {
        const v = arg.namedChildren[arg.namedChildren.length - 1];
        const key = arg.childForFieldName("name")?.text;
        if (key) named.set(key, v);
        else if (v) positional.push(v);
      }
      out.push({ line: a.startPosition.row + 1, positional, named });
    }
  }
  return out;
}

const phpStrings = (n: SyntaxNode | undefined): string[] | null => {
  if (!n) return null;
  if (n.type !== "array_creation_expression") {
    const s = plainString(n);
    return s === null ? null : [s];
  }
  return allDefined(n.namedChildren.map((el) => (el.namedChildren.length === 1 ? plainString(el.namedChildren[0]) : null)));
};

/**
 * Entries of Symfony's routing YAML: each mapping that holds route keys, with
 * its plain scalar values (quotes removed; "" when the value is a nested map),
 * and whether it sits under a when@env block. Only this fixed shape is read.
 */
function yamlEntries(text: string): { line: number; keys: Map<string, string>; conditional: boolean }[] {
  const lines = text.split("\n");
  const out: { line: number; keys: Map<string, string>; conditional: boolean }[] = [];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([\w@.-]+):\s*$/.exec(lines[i]);
    if (!m) continue;
    const childIndent = i + 1 < lines.length ? indentOf(lines[i + 1]) : 0;
    if (childIndent <= m[1].length) continue;
    const keys = new Map<string, string>();
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "" || l.trim().startsWith("#")) continue;
      const ind = indentOf(l);
      if (ind < childIndent) break;
      if (ind > childIndent) continue;
      const kv = /^\s*([\w.-]+):\s*(.*?)\s*$/.exec(l);
      if (kv) keys.set(kv[1], kv[2].replace(/^['"]|['"]$/g, ""));
    }
    if (!keys.has("resource") && !keys.has("path")) continue;
    let conditional = false;
    for (let k = i - 1, limit = m[1].length; k >= 0 && limit > 0; k--) {
      const ind = indentOf(lines[k]);
      if (lines[k].trim() === "" || ind >= limit) continue;
      if (/^\s*when@/.test(lines[k])) conditional = true;
      limit = ind;
    }
    out.push({ line: i + 1, keys, conditional });
  }
  return out;
}

export const symfony: Adapter = {
  name: "symfony",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)composer\.json$/.test(p), (t) => /"symfony\/framework-bundle"\s*:/.test(t)),
  reads: (path) => path.endsWith(".php") || path.endsWith(".twig"),

  async analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = SYMFONY_ROLES.find(([, re]) => re.test(f.path))?.[0];
      if (role) roles.set(f.path, role);
    }
    const w = withheldList();
    const found: FoundRoute[] = [];

    // Routing YAML: the import that loads the app's controllers may carry a
    // prefix, and plain YAML routes may be declared beside it.
    let controllers: { prefix: string } | { reason: string; where: string } | null = null;
    for (const f of scope.files) {
      if (!/(^|\/)config\/routes(\.ya?ml|\/.+\.ya?ml)$/.test(f.path)) continue;
      for (const entry of yamlEntries(scope.read(f.path) ?? "")) {
        const where = `${f.path}:${entry.line}`;
        const resource = entry.keys.get("resource");
        if (resource !== undefined) {
          const isControllers = /routing\.controllers|src\/Controller/.test(resource) || entry.keys.get("type") === "attribute";
          if (!isControllers) continue;
          const prefix = entry.keys.get("prefix");
          if (entry.conditional) controllers = { reason: "the controllers are imported only in some environments", where };
          else if (prefix === "") controllers = { reason: "the controllers' import has a prefix per locale", where };
          else if (controllers === null) controllers = { prefix: prefix ?? "" };
          else controllers = { reason: "the controllers are imported more than once", where };
          continue;
        }
        const path = entry.keys.get("path");
        if (path === undefined || !entry.keys.has("controller")) continue;
        const methods = entry.keys.get("methods");
        const list = methods === undefined ? null : allDefined(methods.replace(/^\[|\]$/g, "").split(/[|,]/).map((m) => UPPER.get(m.trim().replace(/^['"]|['"]$/g, "").toUpperCase())));
        if (entry.conditional) w.add("YAML route declared only in some environments", where);
        else if (methods === undefined) w.add("YAML route without methods answers every method", where);
        else if (!list || path === "") w.add("YAML route's path or methods aren't plain", where);
        else for (const m of list) found.push({ file: f.path, method: m, path: path.startsWith("/") ? path : `/${path}`, line: entry.line });
      }
    }
    const yamlRoutes = found.length;

    const parser = await parserFor("php");
    try {
      for (const f of scope.owned) {
        if (!f.path.endsWith(".php")) continue;
        const text = scope.read(f.path);
        if (text === null || !text.includes("Route")) continue;
        if (/@Route\(/.test(text)) w.add("docblock @Route annotations aren't read; only #[Route] attributes are", f.path);
        const tree = parser.parse(text);
        try {
          for (const cls of tree.rootNode.descendantsOfType("class_declaration")) {
            const classAttrs = routeAttrs(cls);
            if (classAttrs.length > 1) {
              w.add("controller has more than one class-level #[Route], which isn't combined here", `${f.path}:${classAttrs[0].line}`);
              continue;
            }
            const ca = classAttrs[0];
            const prefix = ca ? phpStrings(ca.named.get("path") ?? ca.positional[0]) : [""];
            for (const m of cls.childForFieldName("body")?.namedChildren ?? []) {
              if (m.type !== "method_declaration") continue;
              for (const a of routeAttrs(m)) {
                const where = `${f.path}:${a.line}`;
                if (prefix === null || prefix.length !== 1) {
                  w.add("the controller's #[Route] path isn't one plain string", where);
                  continue;
                }
                if (ca?.named.has("methods")) {
                  w.add("the controller's #[Route] restricts methods, which isn't combined here", where);
                  continue;
                }
                const paths = phpStrings(a.named.get("path") ?? a.positional[0]);
                if (paths === null || paths.length !== 1) {
                  w.add("route path isn't one plain string (localized paths aren't read)", where);
                  continue;
                }
                const listed = a.named.has("methods") ? phpStrings(a.named.get("methods")) : null;
                if (!a.named.has("methods")) {
                  w.add("#[Route] without methods: answers every method", where);
                  continue;
                }
                const methods = listed ? allDefined(listed.map((x) => UPPER.get(x.toUpperCase()))) : null;
                if (!methods) {
                  w.add("methods: isn't a plain list the route table carries", where);
                  continue;
                }
                const path = prefix[0] + paths[0];
                for (const method of methods) found.push({ file: f.path, method, path: path.startsWith("/") ? path : `/${path}`, line: a.line });
              }
            }
          }
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }

    const routes: FoundRoute[] = found.slice(0, yamlRoutes);
    for (const r of found.slice(yamlRoutes)) {
      if (controllers === null) w.add("no route import loads the controllers' attributes, so where they're served isn't known", `${r.file}:${r.line}`);
      else if ("reason" in controllers) w.add(`no full pattern is known: ${controllers.reason} (${controllers.where})`, `${r.file}:${r.line}`);
      else routes.push({ ...r, path: (controllers.prefix + r.path).replace(/^(?!\/)/, "/") });
    }
    return { roles, routes, routesWithheld: w.list() };
  },
};

// ------------------------------------------------------------------- Rocket

// Rocket routes are #[get("/x")] on a function, reached by mount("/base",
// routes![...]) on the Rocket instance. A route is the base and its own URI
// together; a route nothing mounts isn't served, and is withheld.

const ROCKET_FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["handler", ["routes", "handlers", "api"]],
  ["model", ["models", "model"]],
  ["service", ["services"]],
];

export const rocket: Adapter = {
  name: "rocket",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)Cargo\.toml$/.test(p), (t) => /^\s*rocket\s*=|\[dependencies\.rocket\]/m.test(t)),
  reads: (path) => path.endsWith(".rs"),

  async analyze(scope) {
    const w = withheldList();
    const routes: FoundRoute[] = [];
    const handlerFiles = new Set<string>();
    const routerFiles = new Set<string>();
    const rs = await rustProject(scope);
    try {
      // Every attributed handler, by file and function name.
      const handlers = new Map<string, { method: HttpMethod; uri: string; line: number; file: string }[]>();
      for (const f of rs.files.values()) {
        for (const fnItem of f.root.namedChildren.filter((c) => c.type === "function_item")) {
          const name = fnItem.childForFieldName("name")?.text;
          for (let a = fnItem.previousNamedSibling; a?.type === "attribute_item"; a = a.previousNamedSibling) {
            const attr = a.namedChildren[0];
            const attrName = attr?.namedChildren[0]?.text ?? "";
            const method = LOWER.get(attrName);
            if (!method && attrName !== "route") continue;
            const line = a.startPosition.row + 1;
            handlerFiles.add(f.path);
            const uri = plainString(attr?.childForFieldName("arguments")?.namedChildren[0]);
            if (!method) w.add("#[route] names its method as an argument, which isn't read", `${f.path}:${line}`);
            else if (uri === null) w.add("route URI isn't a plain string", `${f.path}:${line}`);
            else handlers.set(`${f.path}#${name}`, [...(handlers.get(`${f.path}#${name}`) ?? []), { method, uri, line, file: f.path }]);
          }
        }
      }

      const mounted = new Set<string>();
      /** The routes! list a mount() is handed: inline, or the tail of a function that returns one. */
      const listOf = (file: string, node: SyntaxNode | undefined, depth = 0): { file: string; text: string } | null => {
        if (!node || depth > 4) return null;
        if (node.type === "macro_invocation" && node.childForFieldName("macro")?.text === "routes") {
          return { file, text: node.namedChildren.find((c) => c.type === "token_tree")?.text ?? "" };
        }
        if (node.type === "call_expression") {
          const target = rs.item(file, node.childForFieldName("function")!);
          const def = target ? rs.fn(target.file, target.name) : null;
          const tail = def ? tailOf(def) : null;
          return target && tail ? listOf(target.file, tail, depth + 1) : null;
        }
        return null;
      };

      for (const f of rs.files.values()) {
        for (const call of f.root.descendantsOfType("call_expression")) {
          const fn = call.childForFieldName("function");
          if (fn?.type !== "field_expression" || fn.childForFieldName("field")?.text !== "mount") continue;
          const args = call.childForFieldName("arguments")?.namedChildren ?? [];
          const where = `${f.path}:${(fn.childForFieldName("field") ?? call).startPosition.row + 1}`;
          const base = plainString(args[0]);
          const list = listOf(f.path, args[1]);
          if (base === null || !list) {
            w.add("mount()'s base or routes list couldn't be read", where);
            continue;
          }
          routerFiles.add(f.path);
          for (const entry of list.text.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean)) {
            const target = rs.itemPath(list.file, entry.split("::").map((s) => s.trim()));
            const hs = target ? handlers.get(`${target.file}#${target.name}`) : undefined;
            if (!target || !hs) {
              w.add("a route in routes![] couldn't be traced to its handler", where);
              continue;
            }
            mounted.add(`${target.file}#${target.name}`);
            for (const h of hs) {
              // Rocket's base and URI: "/" under a base is the base itself.
              const b = base.replace(/\/$/, "");
              const path = h.uri === "/" ? b || "/" : b + h.uri;
              routes.push({ file: h.file, method: h.method, path, line: h.line });
            }
          }
        }
      }
      for (const [key, hs] of handlers) {
        if (!mounted.has(key)) for (const h of hs) w.add("handler isn't in any routes![] that's mounted", `${h.file}:${h.line}`);
      }
    } finally {
      rs.done();
    }
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = routerFiles.has(f.path) ? "router" : handlerFiles.has(f.path) ? "handler" : conventionRole(f.path, ROCKET_FOLDERS);
      if (role) roles.set(f.path, role);
    }
    // The same handler mounted twice at the same base is one route.
    const seen = new Set<string>();
    const unique = routes.filter((r) => {
      const key = `${r.file}
${r.line}
${r.method}
${r.path}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
    return { roles, routes: unique, routesWithheld: w.list() };
  },
};

// ------------------------------------------------------------------ Phoenix

// Phoenix routes are a DSL in the router module: scopes add path, verbs
// declare routes, and `resources` is its fixed eight method-and-path pairs.
// A nested resource's parameter comes from the parent's controller name
// (UserController → :user_id), the way Phoenix derives it.

const PHOENIX_ROLES: readonly (readonly [string, RegExp])[] = [
  ["router", /router\.ex$/],
  ["controller", /_controller\.ex$/],
  ["live view", /(_live\.ex$|\/live\/)/],
  ["component", /\/components\//],
  ["template", /(_html\.ex|_view\.ex|\.heex|\.eex)$/],
  ["channel", /_channel\.ex$/],
  ["migration", /priv\/repo\/migrations\//],
];

const PLURAL: readonly [string, HttpMethod, "collection" | "member", string][] = [
  ["index", "GET", "collection", ""],
  ["edit", "GET", "member", "edit"],
  ["new", "GET", "collection", "new"],
  ["show", "GET", "member", ""],
  ["create", "POST", "collection", ""],
  ["update", "PATCH", "member", ""],
  ["update", "PUT", "member", ""],
  ["delete", "DELETE", "member", ""],
];

type ExArgs = { positional: SyntaxNode[]; keywords: Map<string, SyntaxNode> };

function exArgs(call: SyntaxNode): ExArgs {
  const positional: SyntaxNode[] = [];
  const keywords = new Map<string, SyntaxNode>();
  for (const a of call.namedChildren.find((c) => c.type === "arguments")?.namedChildren ?? []) {
    if (a.type === "keywords") {
      for (const pair of a.namedChildren) {
        const key = pair.childForFieldName("key")?.text.replace(/:\s*$/, "");
        const value = pair.childForFieldName("value");
        if (key && value) keywords.set(key, value);
      }
    } else positional.push(a);
  }
  return { positional, keywords };
}

const exString = (n: SyntaxNode | undefined): string | null =>
  n?.type === "string" && n.namedChildren.every((c) => c.type === "quoted_content") ? n.namedChildren.map((c) => c.text).join("") : null;
const exAtom = (n: SyntaxNode | undefined): string | null => (n?.type === "atom" ? n.text.slice(1) : null);
const exAtoms = (n: SyntaxNode | undefined): string[] | null =>
  n?.type === "list" ? allDefined(n.namedChildren.map(exAtom)) : null;

function joinPhoenix(parts: readonly string[]): string {
  const p = parts.map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${p}`;
}

/** UserController → user; Admin.UserController → user. */
function resourceName(controller: string): string {
  const last = controller.split(".").pop() ?? controller;
  return last.replace(/Controller$/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export const phoenix: Adapter = {
  name: "phoenix",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)mix\.exs$/.test(p), (t) => /\{\s*:phoenix\s*,/.test(t)),
  reads: (path) => /\.(ex|exs|heex|eex)$/.test(path),

  async analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = PHOENIX_ROLES.find(([, re]) => re.test(f.path))?.[0];
      if (role) roles.set(f.path, role);
    }
    const w = withheldList();
    const routes: FoundRoute[] = [];
    const parser = await parserFor("elixir");
    try {
      for (const f of scope.owned) {
        if (!f.path.endsWith(".ex")) continue;
        const text = scope.read(f.path);
        if (text === null || !/use\s+\S+,\s*:router|use\s+Phoenix\.Router/.test(text)) continue;
        const tree = parser.parse(text);
        try {
          const walk = (statements: readonly SyntaxNode[], path: string[], parent: { member: string[]; nested: string[] } | null) => {
            for (const stmt of statements) {
              const where = `${f.path}:${stmt.startPosition.row + 1}`;
              if (stmt.type !== "call") continue;
              const name = stmt.childForFieldName("target")?.text ?? "";
              const args = exArgs(stmt);
              const body = stmt.namedChildren.find((c) => c.type === "do_block")?.namedChildren ?? null;
              const line = stmt.startPosition.row + 1;
              if (["if", "unless", "case", "cond", "for"].includes(name)) {
                w.add("routes declared inside a condition, so whether they exist depends on compile-time configuration", where);
                continue;
              }
              if (name === "defmodule" || name === "live_session") {
                if (body) walk(body, path, parent);
                continue;
              }
              if (name === "scope") {
                const first = args.positional[0];
                const p = first?.type === "string" ? exString(first) : args.keywords.has("path") ? exString(args.keywords.get("path")) : "";
                if (p === null) w.add("scope path isn't a plain string", where);
                else if (body) walk(body, [...path, p], parent);
                continue;
              }
              const verb = LOWER.get(name);
              if (verb || name === "live" || name === "match") {
                let method: HttpMethod | undefined = verb ?? (name === "live" ? "GET" : undefined);
                let pathArg = args.positional[0];
                if (name === "match") {
                  const m = exAtom(args.positional[0]);
                  method = m ? LOWER.get(m) : undefined;
                  pathArg = args.positional[1];
                  if (!method) {
                    w.add("match with :* or a non-literal method answers methods this can't name", where);
                    continue;
                  }
                }
                const p = exString(pathArg);
                if (p === null || !method) w.add("route path isn't a plain string", where);
                else routes.push({ file: f.path, method, path: joinPhoenix([...(parent?.nested ?? []), ...path, p]), line });
                continue;
              }
              if (name === "resources") {
                const p = exString(args.positional[0]);
                const controller = args.positional[1]?.type === "alias" ? args.positional[1].text : null;
                const singleton = args.keywords.get("singleton")?.text === "true";
                const param = args.keywords.has("param") ? exString(args.keywords.get("param")) : "id";
                const only = args.keywords.has("only") ? exAtoms(args.keywords.get("only")) : null;
                const except = args.keywords.has("except") ? exAtoms(args.keywords.get("except")) : null;
                if (p === null || param === null || (args.keywords.has("only") && !only) || (args.keywords.has("except") && !except)) {
                  w.add("resources options aren't plain literals", where);
                  continue;
                }
                const keep = (a: string) => (!only || only.includes(a)) && (!except || !except.includes(a));
                const collection = [...(parent?.nested ?? []), ...path, p];
                const member = singleton ? collection : [...collection, `:${param}`];
                for (const [action, method, on, suffix] of PLURAL) {
                  if (!keep(action) || (singleton && action === "index")) continue;
                  const at = singleton || on === "collection" ? collection : member;
                  routes.push({ file: f.path, method, path: joinPhoenix([...at, suffix]), line });
                }
                if (body) {
                  const nameOpt = args.keywords.has("name") ? exString(args.keywords.get("name")) : controller ? resourceName(controller) : null;
                  if (nameOpt === null) w.add("nested resources under a resource whose name can't be worked out", where);
                  else walk(body, [], { member, nested: singleton ? collection : [...collection, `:${nameOpt}_${param}`] });
                }
                continue;
              }
              if (name === "forward") w.add("forward hands requests to another plug, whose routes aren't read", where);
            }
          };
          walk(tree.rootNode.namedChildren, [], null);
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
    return { roles, routes, routesWithheld: w.list() };
  },
};
