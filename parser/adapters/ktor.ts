import type { Adapter, FoundRoute } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import type { HttpMethod } from "../types.ts";
import { conventionRole, manifestsDeclaring, mentions, withheldList } from "./shared.ts";

// Ktor routes are a nested DSL: routing { route("/users") { get("/{id}") {} } }.
// Each block's path is its parent's plus its own. Routing split into
// extension functions (fun Route.userRoutes()) is followed into the function
// when exactly one function of that name takes a Route; an ambiguous name is
// withheld rather than guessed between.

const VERBS = new Map<string, HttpMethod>([
  ["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"], ["options", "OPTIONS"],
]);
const KTOR_METHODS = new Map<string, HttpMethod>([
  ["Get", "GET"], ["Post", "POST"], ["Put", "PUT"], ["Patch", "PATCH"], ["Delete", "DELETE"], ["Head", "HEAD"], ["Options", "OPTIONS"],
]);

const FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["router", ["routes", "routing", "plugins"]],
  ["service", ["service", "services"]],
  ["repository", ["repository", "repositories", "dao", "db"]],
  ["model", ["model", "models", "domain", "entity"]],
];

/** A DSL call, however Kotlin wrote it: name, arguments, trailing lambda's statements, type arguments. */
type DslCall = { name: string; args: SyntaxNode[]; body: SyntaxNode[] | null; typed: boolean; node: SyntaxNode };

function dslCall(node: SyntaxNode): DslCall | null {
  if (node.type !== "call_expression") return null;
  const [head, suffix] = node.namedChildren;
  if (suffix?.type !== "call_suffix") return null;
  const lambda = suffix.namedChildren.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal");
  const body = lambda ? lambda.namedChildren.find((c) => c.type === "statements")?.namedChildren ?? [] : null;
  // get("/x") { } parses as a call whose callee is the call get("/x").
  if (head?.type === "call_expression" && body !== null) {
    const inner = dslCall(head);
    return inner && inner.body === null ? { ...inner, body, node } : null;
  }
  if (head?.type !== "simple_identifier") return null;
  const args = suffix.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const typed = suffix.namedChildren.some((c) => c.type === "type_arguments");
  return { name: head.text, args, body, typed, node };
}

/** A plain Kotlin string, or null for templates and escapes. */
function kString(n: SyntaxNode | undefined): string | null {
  const v = n?.type === "value_argument" ? n.namedChildren[n.namedChildren.length - 1] : n;
  if (v?.type !== "string_literal") return null;
  if (v.namedChildren.some((c) => c.type !== "string_content") || v.text.includes("\\") || v.text.startsWith('"""')) return null;
  return v.namedChildren.map((c) => c.text).join("");
}

/** Ktor's path segments: leading slashes dropped, one between; a doubled or trailing slash isn't read. */
function join(prefix: readonly string[], path: string): string[] | null {
  const p = path.replace(/^\//, "");
  if (p === "") return [...prefix];
  if (p.includes("//") || p.endsWith("/")) return null;
  return [...prefix, ...p.split("/")];
}

export const ktor: Adapter = {
  name: "ktor",
  claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p), (t) => mentions(t, "ktor-server")),
  reads: (path) => path.endsWith(".kt"),

  async analyze(scope) {
    const w = withheldList();
    const routes: FoundRoute[] = [];
    const routeFiles = new Set<string>();
    const parser = await parserFor("kotlin");
    const trees: { delete(): void }[] = [];

    try {
      type KtFile = { path: string; root: SyntaxNode; broken: boolean };
      const files: KtFile[] = [];
      for (const f of scope.owned) {
        const text = scope.read(f.path);
        if (text === null || !/routing|Route\.|route\(/.test(text)) continue;
        const tree = parser.parse(text);
        trees.push(tree);
        files.push({ path: f.path, root: tree.rootNode, broken: tree.rootNode.hasError });
      }

      // Extension functions on a route builder, by name: fun Route.userRoutes() { ... }.
      const extensions = new Map<string, { file: KtFile; body: SyntaxNode[] }[]>();
      for (const f of files) {
        for (const fn of f.root.descendantsOfType("function_declaration")) {
          const receiver = fn.namedChildren.find((c) => c.type === "user_type")?.text;
          const name = fn.namedChildren.find((c) => c.type === "simple_identifier")?.text;
          if (!name || !receiver || !/^(Route|Routing)$/.test(receiver)) continue;
          const body = fn.namedChildren.find((c) => c.type === "function_body")?.namedChildren.find((c) => c.type === "statements")?.namedChildren ?? [];
          extensions.set(name, [...(extensions.get(name) ?? []), { file: f, body }]);
        }
      }

      const walk = (file: KtFile, statements: readonly SyntaxNode[], prefix: string[], method: HttpMethod | null, stack: readonly string[]) => {
        for (const stmt of statements) {
          const where = `${file.path}:${stmt.startPosition.row + 1}`;
          if (/^(if|when|for|while)_expression$|^(for|while|do_while)_statement$/.test(stmt.type)) {
            if (/\b(get|post|put|patch|delete|route)\s*[({]/.test(stmt.text)) w.add("routes declared inside a condition or loop, so whether they exist depends on running the app", where);
            continue;
          }
          const c = dslCall(stmt);
          if (!c) continue;
          const line = c.node.startPosition.row + 1;
          const verb = VERBS.get(c.name);
          if (verb && c.body !== null) {
            if (c.typed) {
              w.add("type-safe resource route: its path comes from a @Resource class, which isn't read", where);
              continue;
            }
            const p = c.args.length ? kString(c.args[0]) : "";
            const segs = p === null ? null : join(prefix, p);
            if (p === "/" && prefix.length > 0) w.add("a nested \"/\" route: whether it answers with a trailing slash depends on configuration", where);
            else if (segs === null) w.add("route path isn't a plain string, or has a doubled or trailing slash", where);
            else {
              routeFiles.add(file.path);
              routes.push({ file: file.path, method: verb, path: `/${segs.join("/")}`, line });
            }
            continue;
          }
          if (c.name === "route" && c.body !== null) {
            const p = kString(c.args[0]);
            const segs = p === null ? null : join(prefix, p);
            if (segs === null) {
              w.add("route() path isn't a plain string, or has a doubled or trailing slash", where);
              continue;
            }
            // route("/x", HttpMethod.Get) { handle { } } fixes the method for what's inside.
            const m = c.args[1] ? KTOR_METHODS.get(c.args[1].text.split(".").pop() ?? "") : undefined;
            if (c.args[1] && !m) {
              w.add("route()'s method isn't a plain HttpMethod", where);
              continue;
            }
            walk(file, c.body, segs, m ?? method, stack);
            continue;
          }
          if (c.name === "method" && c.body !== null) {
            const m = KTOR_METHODS.get(c.args[0]?.text.split(".").pop() ?? "");
            if (!m) w.add("method()'s argument isn't a plain HttpMethod", where);
            else walk(file, c.body, prefix, m, stack);
            continue;
          }
          if (c.name === "handle" && c.body !== null) {
            if (!method) w.add("handle {} outside a method answers every method", where);
            else {
              routeFiles.add(file.path);
              routes.push({ file: file.path, method, path: `/${prefix.join("/")}`, line });
            }
            continue;
          }
          if (c.body === null && c.args.length === 0) {
            // userRoutes(): an extension function holding more routing.
            const targets = extensions.get(c.name);
            if (!targets) continue;
            if (targets.length > 1) w.add(`more than one routing function is named ${c.name}, so which one this calls isn't known`, where);
            else if (stack.includes(c.name)) w.add("routing functions call each other in a loop", where);
            else walk(targets[0].file, targets[0].body, prefix, method, [...stack, c.name]);
            continue;
          }
          // authenticate { }, rateLimit { } and other wrappers keep the path they're in.
          if (c.body !== null) walk(file, c.body, prefix, method, stack);
        }
      };

      for (const f of files) {
        if (f.broken) {
          w.add("file has syntax the available grammar can't fully read, so its routes aren't trusted", f.path);
          continue;
        }
        for (const call of f.root.descendantsOfType("call_expression")) {
          const c = dslCall(call);
          if (c?.name === "routing" && c.body !== null) walk(f, c.body, [], null, []);
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
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = routeFiles.has(f.path) ? "router" : conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes: unique, routesWithheld: w.list() };
  },
};
