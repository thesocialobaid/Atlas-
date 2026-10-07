import type { Adapter, FoundRoute } from "../adapter.ts";
import type { SyntaxNode } from "../languages/tree-sitter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { pyArg, pyConditional, pyProject, pyStrings, type PyProject } from "./python.ts";
import { allDefined, conventionRole, plainString, pythonDepending, withheldList } from "./shared.ts";
import type { DjangoRole } from "./taxonomy.ts";

// Django's URLs start at ROOT_URLCONF and follow include() from there, each
// level's route string concatenated onto the last. A route has no method of
// its own: the view decides, so the method is read from the view — its
// require_http_methods-style decorator, or the handler methods its class
// defines. A view that answers whatever arrives has no method to list.

const FOLDERS: readonly (readonly [DjangoRole, readonly string[]])[] = [
  ["migration", ["migrations"]],
  ["command", ["commands"]],
  ["urls", ["urls"]],
  ["view", ["views"]],
  ["serializer", ["serializers"]],
  ["form", ["forms"]],
  ["model", ["models"]],
  ["admin", ["admin"]],
  ["signal", ["signals"]],
  ["task", ["tasks"]],
  ["middleware", ["middleware"]],
  ["settings", ["settings"]],
  ["app config", ["apps"]],
];

const LOWER = new Map(HTTP_METHODS.map((m) => [m.toLowerCase(), m]));

// Decorators that fix a function view's methods, by where they're imported from.
const FIXED = new Map<string, HttpMethod[]>([
  ["django.views.decorators.http.require_GET", ["GET"]],
  ["django.views.decorators.http.require_POST", ["POST"]],
  ["django.views.decorators.http.require_safe", ["GET", "HEAD"]],
]);
const LISTED = new Set(["django.views.decorators.http.require_http_methods", "rest_framework.decorators.api_view"]);

// Base views that answer only the handler methods a subclass defines.
const PLAIN_BASES = new Set([
  "django.views.View",
  "django.views.generic.View",
  "django.views.generic.base.View",
  "rest_framework.views.APIView",
]);

const ROUTE_FNS = new Set(["django.urls.path"]);
const REGEX_FNS = new Set(["django.urls.re_path", "django.conf.urls.url", "django.conf.urls.re_path"]);
const INCLUDE_FNS = new Set(["django.urls.include", "django.conf.urls.include"]);

/** The external name a callee or decorator refers to, through `from x import y` or `import x`. */
function externalName(py: PyProject, file: string, node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "call") return py.externalCallee(file, node);
  const f = py.file(file);
  if (!f) return null;
  if (node.type === "identifier") {
    const b = f.bindings.get(node.text);
    return b && "external" in b ? b.external : null;
  }
  if (node.type === "attribute") {
    const b = f.bindings.get(node.childForFieldName("object")?.text ?? "");
    const attr = node.childForFieldName("attribute")?.text;
    return b && "external" in b && attr ? `${b.external}.${attr}` : null;
  }
  return null;
}

/** The def or class a target names, if it is one. */
function definition(py: PyProject, file: string, name: string): SyntaxNode | null {
  const nodes = py.file(file)?.defs.get(name) ?? [];
  return nodes.length === 1 && (nodes[0].type === "function_definition" || nodes[0].type === "class_definition") ? nodes[0] : null;
}

type Methods = { methods: HttpMethod[] } | { reason: string };

/** Handler methods a class-based view answers: its own, and those of repository classes it extends. */
function classMethods(py: PyProject, file: string, cls: SyntaxNode, depth: number): Methods {
  if (depth > 6) return { reason: "class-based view's inheritance is too deep to follow" };
  const body = cls.childForFieldName("body");
  const out = new Set<HttpMethod>();
  for (const stmt of body?.namedChildren ?? []) {
    const fn = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : stmt;
    if (fn?.type === "function_definition") {
      const m = LOWER.get(fn.childForFieldName("name")?.text ?? "");
      if (m) out.add(m);
    }
    if (stmt.type === "expression_statement" && stmt.namedChildren[0]?.type === "assignment" && stmt.namedChildren[0].childForFieldName("left")?.text === "http_method_names") {
      return { reason: "class-based view sets http_method_names, which isn't read" };
    }
  }
  for (const base of cls.childForFieldName("superclasses")?.namedChildren ?? []) {
    if (base.type === "keyword_argument") continue;
    const ext = externalName(py, file, base);
    if (ext !== null) {
      if (PLAIN_BASES.has(ext)) continue;
      return { reason: `class-based view inherits from ${ext}, whose handler methods come from the framework` };
    }
    const target = py.resolve(file, base);
    const parent = target?.name ? definition(py, target.file, target.name) : null;
    if (!target || !parent || parent.type !== "class_definition") {
      return { reason: "class-based view inherits from a class that couldn't be traced" };
    }
    const inherited = classMethods(py, target.file, parent, depth + 1);
    if ("reason" in inherited) return inherited;
    for (const m of inherited.methods) out.add(m);
  }
  if (out.size === 0) return { reason: "class-based view defines no handler methods of its own" };
  return { methods: HTTP_METHODS.filter((m) => out.has(m)) };
}

/** The methods a view answers, from what's written on it. */
function viewMethods(py: PyProject, file: string, view: SyntaxNode): Methods {
  // SomeView.as_view() — or a DRF viewset's as_view({"get": "list"}), whose keys are the methods.
  if (view.type === "call") {
    const fn = view.childForFieldName("function");
    if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "as_view") {
      return { reason: "view is the result of a call, which isn't followed" };
    }
    const actions = pyArg(view, 0, "actions");
    if (actions?.type === "dictionary") {
      const out: HttpMethod[] = [];
      for (const pair of actions.namedChildren) {
        const key = pair.type === "pair" ? plainString(pair.childForFieldName("key")) : null;
        const m = key === null ? undefined : LOWER.get(key.toLowerCase());
        if (!m) return { reason: "viewset action map isn't a plain dictionary of methods" };
        out.push(m);
      }
      return { methods: out };
    }
    const object = fn.childForFieldName("object");
    const target = object ? py.resolve(file, object) : null;
    const cls = target?.name ? definition(py, target.file, target.name) : null;
    if (!target || cls?.type !== "class_definition") {
      const ext = externalName(py, file, object);
      return { reason: ext ? `view is ${ext}, whose handler methods come from the framework` : "class-based view couldn't be traced to its class" };
    }
    return classMethods(py, target.file, cls, 0);
  }

  const target = py.resolve(file, view);
  const fn = target?.name ? definition(py, target.file, target.name) : null;
  if (!target || !fn || fn.type !== "function_definition") {
    const ext = externalName(py, file, view);
    return { reason: ext ? `view comes from an installed package (${ext}), whose methods aren't read` : "view couldn't be traced to the function it names" };
  }
  const decorated = fn.parent?.type === "decorated_definition" ? fn.parent : null;
  for (const d of decorated?.namedChildren.filter((c) => c.type === "decorator") ?? []) {
    const expr = d.namedChildren[0];
    const ext = externalName(py, target.file, expr ?? null);
    if (ext === null) continue;
    const fixed = FIXED.get(ext);
    if (fixed) return { methods: fixed };
    if (LISTED.has(ext)) {
      // api_view() with nothing listed allows GET only.
      const listed = expr?.type === "call" ? pyArg(expr, 0, ext.endsWith("api_view") ? "http_method_names" : "request_method_list") : null;
      if (expr?.type === "call" && listed === null && ext.endsWith("api_view")) return { methods: ["GET"] };
      const names = pyStrings(listed);
      if (names === null) return { reason: "the view's allowed methods aren't a plain list of strings" };
      const out: HttpMethod[] = [];
      for (const n of names) {
        const m = LOWER.get(n.toLowerCase());
        if (!m) return { reason: `method ${n} isn't one the route table carries` };
        if (!out.includes(m)) out.push(m);
      }
      return { methods: out };
    }
  }
  return { reason: "function view answers any method; nothing on it restricts which" };
}

const VIEWSET_BASES = new Map<string, readonly string[]>([
  ["rest_framework.viewsets.ModelViewSet", ["list", "create", "retrieve", "update", "partial_update", "destroy"]],
  ["rest_framework.viewsets.ReadOnlyModelViewSet", ["list", "retrieve"]],
  ["rest_framework.viewsets.GenericViewSet", []],
  ["rest_framework.viewsets.ViewSet", []],
  ["rest_framework.viewsets.ViewSetMixin", []],
  ["rest_framework.generics.GenericAPIView", []],
  ["rest_framework.mixins.ListModelMixin", ["list"]],
  ["rest_framework.mixins.CreateModelMixin", ["create"]],
  ["rest_framework.mixins.RetrieveModelMixin", ["retrieve"]],
  ["rest_framework.mixins.UpdateModelMixin", ["update", "partial_update"]],
  ["rest_framework.mixins.DestroyModelMixin", ["destroy"]],
]);
const ACTIONS = new Set(["list", "create", "retrieve", "update", "partial_update", "destroy"]);

type Extra = { detail: boolean; methods: HttpMethod[]; path: string; line: number; file: string } | { reason: string; where: string };
type Viewset = { actions: Set<string>; extra: Extra[]; lookup: string } | { reason: string };

/** What a DRF viewset answers: the actions its bases and its own methods provide, and its @action routes. */
function viewset(py: PyProject, file: string, cls: SyntaxNode, depth: number): Viewset {
  if (depth > 6) return { reason: "viewset's inheritance is too deep to follow" };
  const actions = new Set<string>();
  const extra: Extra[] = [];
  let lookup: string | null = null;
  let lookupKwarg: string | null = null;
  for (const base of cls.childForFieldName("superclasses")?.namedChildren ?? []) {
    if (base.type === "keyword_argument") continue;
    const ext = externalName(py, file, base);
    if (ext !== null) {
      const provides = VIEWSET_BASES.get(ext);
      if (!provides) return { reason: `viewset inherits from ${ext}, whose actions aren't read` };
      provides.forEach((a) => actions.add(a));
      continue;
    }
    const t = py.resolve(file, base);
    const parent = t?.name ? definition(py, t.file, t.name) : null;
    if (!t || parent?.type !== "class_definition") return { reason: "viewset inherits from a class that couldn't be traced" };
    const inherited = viewset(py, t.file, parent, depth + 1);
    if ("reason" in inherited) return inherited;
    inherited.actions.forEach((a) => actions.add(a));
    extra.push(...inherited.extra);
    if (inherited.lookup !== "pk") lookup = inherited.lookup;
  }
  for (const stmt of cls.childForFieldName("body")?.namedChildren ?? []) {
    const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    if (assign?.type === "assignment") {
      const left = assign.childForFieldName("left")?.text;
      const value = plainString(assign.childForFieldName("right"));
      if (left === "http_method_names") return { reason: "viewset sets http_method_names, which isn't read" };
      if (left === "lookup_field" || left === "lookup_url_kwarg") {
        if (value === null) return { reason: `${left} isn't a plain string` };
        if (left === "lookup_field") lookup = value;
        else lookupKwarg = value;
      }
    }
    const decorated = stmt.type === "decorated_definition" ? stmt : null;
    const fn = decorated ? decorated.childForFieldName("definition") : stmt;
    if (fn?.type !== "function_definition") continue;
    const name = fn.childForFieldName("name")?.text ?? "";
    if (ACTIONS.has(name)) actions.add(name);
    for (const d of decorated?.namedChildren.filter((c) => c.type === "decorator") ?? []) {
      const call = d.namedChildren[0];
      if (call?.type !== "call" || externalName(py, file, call) !== "rest_framework.decorators.action") continue;
      const line = d.startPosition.row + 1;
      const where = `${file}:${line}`;
      const detail = pyArg(call, null, "detail");
      if (detail?.type !== "true" && detail?.type !== "false") {
        extra.push({ reason: "@action's detail isn't True or False", where });
        continue;
      }
      const listed = pyArg(call, null, "methods");
      const names = listed ? pyStrings(listed) : ["get"];
      const methods = names ? allDefined(names.map((n) => LOWER.get(n.toLowerCase()))) : null;
      const urlPath = pyArg(call, null, "url_path");
      const path = urlPath ? plainString(urlPath) : name;
      if (!methods || path === null) {
        extra.push({ reason: "@action's methods or url_path aren't plain strings", where });
        continue;
      }
      extra.push({ detail: detail.type === "true", methods, path, line, file });
    }
  }
  return { actions, extra, lookup: lookupKwarg ?? lookup ?? "pk" };
}

export const django: Adapter = {
  name: "django",
  claims: (input) => pythonDepending(input, "django"),
  reads: (path) => path.endsWith(".py"),

  async analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }

    const py = await pyProject(scope);
    const withheld = withheldList();
    const routes: FoundRoute[] = [];
    const visited = new Set<string>();
    const byModule = new Map(scope.owned.filter((f) => f.module).map((f) => [f.module!, f.path]));

    /** Elements of a pattern list, flattening `[...] + [...]`. Null if any part is computed. */
    const elements = (node: SyntaxNode | null): SyntaxNode[] | null => {
      if (!node) return null;
      if (node.type === "list") return node.namedChildren;
      // `urlpatterns = router.urls`: a DRF router's patterns, expanded where they're walked.
      if (node.type === "attribute" && node.childForFieldName("attribute")?.text === "urls") return [node];
      if (node.type === "binary_operator" && node.childForFieldName("operator")?.text === "+") {
        const l = elements(node.childForFieldName("left"));
        const r = elements(node.childForFieldName("right"));
        return l && r ? [...l, ...r] : null;
      }
      return null;
    };

    /** Every pattern a URL config file contributes, with the statement it came from. */
    const patternsOf = (file: string): { items: SyntaxNode[]; at: SyntaxNode }[] | string => {
      const f = py.file(file);
      if (!f) return "URL config couldn't be read";
      const assigned = (f.defs.get("urlpatterns") ?? []).filter((n) => n.type === "assignment");
      if (assigned.length === 0) return "URL config has no urlpatterns";
      if (assigned.length > 1) return "urlpatterns is assigned more than once";
      const out: { items: SyntaxNode[]; at: SyntaxNode }[] = [];
      const first = elements(assigned[0].childForFieldName("right"));
      if (first === null) return "urlpatterns is built from something computed";
      out.push({ items: first, at: assigned[0] });
      for (const aug of f.root.descendantsOfType("augmented_assignment")) {
        if (aug.childForFieldName("left")?.text !== "urlpatterns") continue;
        const more = elements(aug.childForFieldName("right"));
        if (more === null) withheld.add("patterns added to urlpatterns from something computed", `${file}:${aug.startPosition.row + 1}`);
        else out.push({ items: more, at: aug });
      }
      return out;
    };

    /**
     * A DRF router's .urls, expanded: each register(prefix, ViewSet) is the
     * actions that viewset really has, at DRF's {prefix}/ and
     * {prefix}/{lookup}/ patterns. False when the object isn't a DRF router.
     */
    const drf = (file: string, urls: SyntaxNode, prefix: string, where: string): boolean => {
      const object = urls.childForFieldName("object");
      const target = object ? py.resolve(file, object) : null;
      if (!target?.name) return false;
      const def = py.file(target.file)?.defs.get(target.name) ?? [];
      const call = def.length === 1 && def[0].type === "assignment" ? def[0].childForFieldName("right") : null;
      const kind = call?.type === "call" ? py.externalCallee(target.file, call) : null;
      if (!call || (kind !== "rest_framework.routers.DefaultRouter" && kind !== "rest_framework.routers.SimpleRouter")) return false;
      const routerLine = call.startPosition.row + 1;
      const slashArg = pyArg(call, null, "trailing_slash");
      const slash = slashArg === null || slashArg.type === "true" ? "/" : slashArg.type === "false" ? "" : null;
      if (slash === null) {
        withheld.add("the router's trailing_slash isn't True or False", where);
        return true;
      }
      const at = (...parts: string[]) => `/${prefix}${parts.join("/")}${slash}`;
      if (kind === "rest_framework.routers.DefaultRouter") {
        routes.push({ file: target.file, method: "GET", path: `/${prefix}`, line: routerLine });
        withheld.add("DefaultRouter's format-suffix variants (users.json and the like) aren't listed", `${target.file}:${routerLine}`);
      }

      for (const f of scope.owned) {
        if (!scope.read(f.path)?.includes(".register(")) continue;
        for (const reg of py.file(f.path)?.root.descendantsOfType("call") ?? []) {
          const fn = reg.childForFieldName("function");
          if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "register") continue;
          const owner = fn.childForFieldName("object");
          const same = owner ? py.resolve(f.path, owner) : null;
          if (!same || same.file !== target.file || same.name !== target.name) continue;
          const line = reg.startPosition.row + 1;
          const here = `${f.path}:${line}`;
          if (pyConditional(reg)) {
            withheld.add("viewset registered inside a condition", here);
            continue;
          }
          const p = plainString(pyArg(reg, 0, "prefix"));
          const vs = pyArg(reg, 1, "viewset");
          if (p === null || p === "" || !vs) {
            withheld.add("register()'s prefix isn't a plain, non-empty string", here);
            continue;
          }
          const t = py.resolve(f.path, vs);
          const cls = t?.name ? definition(py, t.file, t.name) : null;
          if (!t || cls?.type !== "class_definition") {
            withheld.add("viewset couldn't be traced to its class", here);
            continue;
          }
          const v = viewset(py, t.file, cls, 0);
          if ("reason" in v) {
            withheld.add(v.reason, here);
            continue;
          }
          const lookup = `{${v.lookup}}`;
          const add = (method: HttpMethod, path: string, l = line, file = f.path) => routes.push({ file, method, path, line: l });
          if (v.actions.has("list")) add("GET", at(p));
          if (v.actions.has("create")) add("POST", at(p));
          if (v.actions.has("retrieve")) add("GET", at(p, lookup));
          if (v.actions.has("update")) add("PUT", at(p, lookup));
          if (v.actions.has("partial_update")) add("PATCH", at(p, lookup));
          if (v.actions.has("destroy")) add("DELETE", at(p, lookup));
          for (const x of v.extra) {
            if ("reason" in x) withheld.add(x.reason, x.where);
            else for (const m of x.methods) add(m, x.detail ? at(p, lookup, x.path) : at(p, x.path), x.line, x.file);
          }
        }
      }
      return true;
    };

    const walk = (file: string, items: SyntaxNode[], at: SyntaxNode, prefix: string, stack: readonly string[]) => {
      for (const item of items) {
        const where = `${file}:${item.startPosition.row + 1}`;
        if (item.type === "attribute") {
          if (!drf(file, item, prefix, where)) withheld.add("patterns generated by another object's .urls (the admin site, a router)", where);
          continue;
        }
        if (item.type !== "call") {
          withheld.add("pattern list entry isn't a path() call", where);
          continue;
        }
        if (pyConditional(at) || pyConditional(item)) {
          withheld.add("pattern added inside a condition or loop, so whether it exists depends on running the code", where);
          continue;
        }
        const callee = py.externalCallee(file, item);
        if (callee !== null && REGEX_FNS.has(callee)) {
          withheld.add("regular-expression pattern (re_path/url): its matches aren't a path pattern", where);
          continue;
        }
        if (callee === null || !ROUTE_FNS.has(callee)) {
          withheld.add("pattern list entry is a call this doesn't read (i18n_patterns, static(), a helper)", where);
          continue;
        }
        const route = plainString(pyArg(item, 0, "route"));
        if (route === null) {
          withheld.add("route isn't a plain string", where);
          continue;
        }
        if (route.startsWith("/")) {
          withheld.add("route starts with /, which Django never matches", where);
          continue;
        }
        const view = pyArg(item, 1, "view");
        if (!view) {
          withheld.add("path() has no view", where);
          continue;
        }
        const full = prefix + route;
        if (view.type === "attribute" && view.childForFieldName("attribute")?.text === "urls") {
          if (!drf(file, view, full, where)) withheld.add("patterns generated by another object's .urls (the admin site, a router)", where);
          continue;
        }
        if (view.type === "call" && py.externalCallee(file, view) !== null && INCLUDE_FNS.has(py.externalCallee(file, view)!)) {
          include(file, view, full, stack, where);
          continue;
        }
        const methods = viewMethods(py, file, view);
        if ("reason" in methods) {
          withheld.add(methods.reason, where);
          continue;
        }
        for (const method of methods.methods) routes.push({ file, method, path: `/${full}`, line: item.startPosition.row + 1 });
      }
    };

    const include = (file: string, call: SyntaxNode, prefix: string, stack: readonly string[], where: string) => {
      let arg = pyArg(call, 0, "arg");
      if (arg?.type === "tuple") arg = arg.namedChildren[0] ?? null;
      if (!arg) return withheld.add("include() has no argument", where);
      const named = plainString(arg);
      if (named !== null) {
        const target = byModule.get(named);
        if (!target) return withheld.add(`include("${named}") names a module that isn't in this project`, where);
        return config(target, prefix, stack, where);
      }
      if (arg.type === "list") return walk(file, arg.namedChildren, call, prefix, stack);
      if (arg.type === "attribute" && arg.childForFieldName("attribute")?.text === "urls") {
        if (drf(file, arg, prefix, where)) return;
        return withheld.add("include() of something's .urls (a router, or a package's URL module), which isn't read", where);
      }
      const ext = externalName(py, file, arg);
      if (ext) return withheld.add(`include() of an installed package's URLs (${ext}), which aren't in this repository`, where);
      const target = py.resolve(file, arg);
      if (target && target.name === null) return config(target.file, prefix, stack, where);
      const node = target?.name ? (py.file(target.file)?.defs.get(target.name) ?? []) : [];
      if (target && node.length === 1 && node[0].type === "assignment") {
        const list = elements(node[0].childForFieldName("right"));
        if (list) return walk(target.file, list, node[0], prefix, stack);
      }
      return withheld.add("include() argument couldn't be traced to a URL config", where);
    };

    const config = (file: string, prefix: string, stack: readonly string[], where: string) => {
      if (stack.includes(file)) return withheld.add("URL configs include each other in a loop", where);
      visited.add(file);
      const patterns = patternsOf(file);
      if (typeof patterns === "string") return withheld.add(patterns, `${file}`);
      for (const p of patterns) walk(file, p.items, p.at, prefix, [...stack, file]);
    };

    try {
      // ROOT_URLCONF is a setting: one plain module name, or nothing is known.
      const roots = new Set<string | null>();
      let rootWhere = "";
      for (const f of scope.owned) {
        const file = f.path.endsWith(".py") && scope.read(f.path)?.includes("ROOT_URLCONF") ? py.file(f.path) : null;
        for (const node of file?.defs.get("ROOT_URLCONF") ?? []) {
          if (node.type !== "assignment") continue;
          roots.add(plainString(node.childForFieldName("right")));
          rootWhere = `${f.path}:${node.startPosition.row + 1}`;
        }
      }
      const rootModule = roots.size === 1 ? [...roots][0] : null;
      const rootFile = rootModule === null ? undefined : byModule.get(rootModule);
      if (rootFile) config(rootFile, "", [], rootWhere);

      // URL configs nothing reachable includes: their routes have no known prefix.
      const why =
        roots.size === 0
          ? "no ROOT_URLCONF setting was found, so where URLs start isn't known"
          : roots.size > 1 || rootModule === null
            ? "ROOT_URLCONF isn't one plain module name, so where URLs start isn't known"
            : rootFile === undefined
              ? `ROOT_URLCONF names ${rootModule}, which isn't in this project`
              : "URL config isn't included from ROOT_URLCONF anywhere this can follow";
      for (const f of scope.owned) {
        if (visited.has(f.path) || !scope.read(f.path)?.includes("urlpatterns")) continue;
        const file = py.file(f.path);
        if (!file?.defs.has("urlpatterns")) continue;
        for (const call of file.root.descendantsOfType("call")) {
          const callee = py.externalCallee(f.path, call);
          if (callee && (ROUTE_FNS.has(callee) || REGEX_FNS.has(callee))) withheld.add(why, `${f.path}:${call.startPosition.row + 1}`);
        }
      }
    } finally {
      py.done();
    }

    return { roles, routes, routesWithheld: withheld.list() };
  },
};
