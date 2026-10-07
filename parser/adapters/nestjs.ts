import { ts } from "ts-morph";
import type { Adapter } from "../adapter.ts";
import type { FoundRoute } from "../adapter.ts";
import type { HttpMethod } from "../types.ts";
import { isScript, lineOf, literalString, packagesDepending, syntaxOf, withheldList } from "./shared.ts";
import type { NestjsRole } from "./taxonomy.ts";

// NestJS names a file for what it is (users.controller.ts), and a route is
// assembled from two decorators: the controller's path and the method's.
// Anything that rewrites paths at runtime (a global prefix that isn't a plain
// string, RouterModule, versioning) makes every pattern unknowable, so then
// none is shown.

// Each role is its own filename suffix: users.controller.ts is a controller.
const SUFFIXES: readonly NestjsRole[] = [
  "controller", "resolver", "gateway", "service", "repository", "entity", "schema",
  "dto", "module", "guard", "interceptor", "pipe", "filter", "middleware",
];

function roleOf(path: string): NestjsRole | null {
  const m = /\.([a-z]+)\.[mc]?[jt]s$/.exec(path);
  return (m && SUFFIXES.find((s) => s === m[1])) ?? null;
}

const METHOD_DECORATORS = new Map<string, HttpMethod>([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Head", "HEAD"],
  ["Options", "OPTIONS"],
]);

/**
 * Local names bound to @nestjs/common's exports in this file. A decorator only
 * counts if it really is Nest's, not something else that happens to be called Get.
 */
function commonImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || literalString(s.moduleSpecifier) !== "@nestjs/common") continue;
    const bindings = s.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) out.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return out;
}

type Call = { name: string; args: readonly ts.Expression[]; line: number };

function decoratorsOf(node: ts.Node, sf: ts.SourceFile, imports: Map<string, string>): Call[] {
  if (!ts.canHaveDecorators(node)) return [];
  const out: Call[] = [];
  for (const d of ts.getDecorators(node) ?? []) {
    const e = d.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) continue;
    const name = imports.get(e.expression.text);
    if (name) out.push({ name, args: e.arguments, line: lineOf(sf, d) });
  }
  return out;
}

/** The paths a decorator argument names: none is "", a literal or a list of literals. */
function pathsOf(args: readonly ts.Expression[]): string[] | null {
  if (args.length === 0) return [""];
  const a = args[0];
  const s = literalString(a);
  if (s !== null) return [s];
  if (!ts.isArrayLiteralExpression(a)) return null;
  const out: string[] = [];
  for (const e of a.elements) {
    const v = literalString(e);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/** @Controller's argument: its paths, or why they can't be read. */
function controllerPaths(args: readonly ts.Expression[]): string[] | string {
  const a = args[0];
  if (a && ts.isObjectLiteralExpression(a)) {
    let paths: string[] | null = [""];
    for (const p of a.properties) {
      if (!ts.isPropertyAssignment(p)) return "controller options aren't a plain object literal";
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key === "version") return "controller declares a version, which adds a prefix this doesn't read";
      if (key === "path") paths = pathsOf([p.initializer]);
    }
    return paths ?? "controller path isn't a string literal";
  }
  return pathsOf(args) ?? "controller path isn't a string literal";
}

/**
 * Nest adds a leading slash to each part and drops a trailing one. Anything
 * stranger (a doubled slash, a trailing one mid-pattern) is left unread rather
 * than normalised by a guess.
 */
function joinPath(parts: string[]): string | null {
  const segs: string[] = [];
  for (const raw of parts) {
    const p = raw.startsWith("/") ? raw.slice(1) : raw;
    if (p === "") continue;
    if (p.includes("//") || p.endsWith("/")) return null;
    segs.push(p);
  }
  return `/${segs.join("/")}`;
}

/** Calls to `.name(...)` anywhere in the file. */
function methodCalls(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const nestjs: Adapter = {
  name: "nestjs",
  claims: (input) => packagesDepending(input, "@nestjs/core"),
  reads: isScript,

  analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = roleOf(f.path);
      if (role) roles.set(f.path, role);
    }

    const withheld = withheldList();
    const found: FoundRoute[] = [];
    // Facts about the whole application that change every pattern.
    let blocked: string | null = null;
    const bootstraps = new Set<string>();
    const prefixes: { value: string | null; where: string }[] = [];

    for (const f of scope.owned) {
      const text = scope.read(f.path);
      if (text === null) continue;
      const scan = /@Controller|setGlobalPrefix|enableVersioning|RouterModule|NestFactory/.test(text);
      if (!scan) continue;
      const sf = syntaxOf(f.path, text);

      if (text.includes("NestFactory") && methodCalls(sf, "create").some((c) => c.expression.getText(sf) === "NestFactory.create")) {
        bootstraps.add(f.path);
      }
      for (const c of methodCalls(sf, "setGlobalPrefix")) {
        const value = c.arguments.length === 1 ? literalString(c.arguments[0]) : null;
        prefixes.push({ value, where: `${f.path}:${lineOf(sf, c)}` });
      }
      const versioning = methodCalls(sf, "enableVersioning")[0];
      if (versioning) blocked ??= `the application enables versioning (${f.path}:${lineOf(sf, versioning)}), which adds a version prefix this doesn't read`;
      for (const s of sf.statements) {
        if (!ts.isImportDeclaration(s) || literalString(s.moduleSpecifier) !== "@nestjs/core") continue;
        const b = s.importClause?.namedBindings;
        if (b && ts.isNamedImports(b) && b.elements.some((e) => (e.propertyName ?? e.name).text === "RouterModule")) {
          blocked ??= `RouterModule is used (${f.path}), which prefixes some modules' routes in a way this doesn't read`;
        }
      }

      const imports = commonImports(sf);
      if (imports.size === 0) continue;
      for (const cls of sf.statements) {
        if (!ts.isClassDeclaration(cls)) continue;
        const controller = decoratorsOf(cls, sf, imports).find((d) => d.name === "Controller");
        if (!controller) continue;
        const ctrl = controllerPaths(controller.args);

        for (const member of cls.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          const decorators = decoratorsOf(member, sf, imports);
          const versioned = decorators.some((d) => d.name === "Version");
          for (const d of decorators) {
            const where = `${f.path}:${d.line}`;
            if (d.name === "All") {
              withheld.add("@All() answers every method, so no single method can be named", where);
              continue;
            }
            if (d.name === "Search") {
              withheld.add("@Search() uses the SEARCH method, which the route table doesn't carry", where);
              continue;
            }
            const method = METHOD_DECORATORS.get(d.name);
            if (!method) continue;
            if (typeof ctrl === "string") {
              withheld.add(ctrl, where);
              continue;
            }
            if (versioned) {
              withheld.add("handler declares @Version, which adds a prefix this doesn't read", where);
              continue;
            }
            const own = pathsOf(d.args);
            if (own === null) {
              withheld.add("handler path isn't a string literal", where);
              continue;
            }
            for (const c of ctrl) {
              for (const m of own) {
                const path = joinPath([c, m]);
                if (path === null) withheld.add("path has a doubled or trailing slash; how Nest normalises it isn't read here", where);
                else found.push({ file: f.path, method, path, line: d.line });
              }
            }
          }
        }
      }
    }

    if (blocked === null && prefixes.length > 0) {
      const values = new Set(prefixes.map((p) => p.value));
      if (values.has(null)) {
        blocked = `the global prefix isn't a plain string or has exclusions (${prefixes.find((p) => p.value === null)!.where})`;
      } else if (values.size > 1 || bootstraps.size > 1) {
        blocked = `there's more than one application or global prefix (${prefixes[0].where}), and which prefix applies to which controller isn't read`;
      }
    }

    const routes: FoundRoute[] = [];
    if (blocked !== null) {
      for (const r of found) withheld.add(`no full pattern is known: ${blocked}`, `${r.file}:${r.line}`);
    } else {
      const globalPrefix = prefixes[0]?.value ?? "";
      const seen = new Set<string>();
      for (const r of found) {
        const path = joinPath([globalPrefix, r.path]);
        if (path === null) {
          withheld.add("path has a doubled or trailing slash; how Nest normalises it isn't read here", `${r.file}:${r.line}`);
          continue;
        }
        const key = `${r.file}\n${r.method}\n${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({ ...r, path });
      }
    }
    return { roles, routes, routesWithheld: withheld.list() };
  },
};
