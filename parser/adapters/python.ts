import type { AdapterScope } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { plainString } from "./shared.ts";

// What Python adapters share: each file's syntax, the names it defines, and
// where each name it imports really comes from. A name is followed only
// through imports the parser resolved to a file, never matched by spelling.

/** A name in a file: a module-level (or function-level) definition, or the module itself when name is null. */
export type PyTarget = { file: string; name: string | null };

type Binding = { file: string; symbol: string | null } | { external: string };

export type PyFile = {
  path: string;
  root: SyntaxNode;
  /** Every assignment, def and class, by the name it binds, in source order. */
  defs: Map<string, SyntaxNode[]>;
  /** Local name to where it comes from. */
  bindings: Map<string, Binding>;
};

export type PyProject = {
  file(path: string): PyFile | null;
  /** What an expression names: a definition somewhere in the repository, or null. */
  resolve(file: string, node: SyntaxNode): PyTarget | null;
  /** "fastapi.APIRouter" for a call whose callee is imported from an installed package. */
  externalCallee(file: string, call: SyntaxNode): string | null;
  /** Frees the syntax trees. */
  done(): void;
};

function definitionsOf(root: SyntaxNode): Map<string, SyntaxNode[]> {
  const defs = new Map<string, SyntaxNode[]>();
  const add = (name: string, node: SyntaxNode) => defs.set(name, [...(defs.get(name) ?? []), node]);
  const visit = (n: SyntaxNode) => {
    if (n.type === "assignment") {
      const left = n.childForFieldName("left");
      if (left?.type === "identifier") add(left.text, n);
    } else if (n.type === "function_definition" || n.type === "class_definition") {
      const name = n.childForFieldName("name");
      if (name) add(name.text, n);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return defs;
}

function bindingsOf(path: string, root: SyntaxNode, scope: AdapterScope): Map<string, Binding> {
  const records = scope.imports.filter((r) => r.from === path && r.outcome === "resolved");
  const external = scope.imports.filter((r) => r.from === path && r.outcome === "external");
  const at = (line: number) => records.filter((r) => r.line === line);
  const map = new Map<string, Binding>();

  for (const node of root.descendantsOfType("import_from_statement")) {
    const moduleNode = node.childForFieldName("module_name");
    if (!moduleNode) continue;
    const written = moduleNode.text;
    const line = node.startPosition.row + 1;
    const isExternal = external.some((r) => r.line === line && r.specifier === written);
    for (const n of node.childrenForFieldName("name")) {
      const nameNode = n.type === "aliased_import" ? n.childForFieldName("name") : n;
      const alias = n.type === "aliased_import" ? n.childForFieldName("alias")?.text : undefined;
      const name = nameNode?.text;
      if (!name) continue;
      const local = alias ?? name;
      if (isExternal) {
        map.set(local, { external: `${written}.${name}` });
        continue;
      }
      const sub = at(line).find((r) => r.specifier === `${written}.${name}`);
      if (sub) {
        map.set(local, { file: sub.to[0], symbol: null });
        continue;
      }
      const mod = at(line).find((r) => r.specifier === written);
      if (mod) map.set(local, { file: mod.to[0], symbol: name });
    }
  }

  for (const node of root.descendantsOfType("import_statement")) {
    const line = node.startPosition.row + 1;
    for (const n of node.childrenForFieldName("name")) {
      const dotted = (n.type === "aliased_import" ? n.childForFieldName("name") : n)?.text;
      if (!dotted) continue;
      const local = n.type === "aliased_import" ? n.childForFieldName("alias")?.text ?? dotted : dotted;
      const rec = at(line).find((r) => r.specifier === dotted);
      if (rec) map.set(local, { file: rec.to[0], symbol: null });
      else if (external.some((r) => r.line === line && r.specifier === dotted)) map.set(local, { external: dotted });
    }
  }
  return map;
}

export async function pyProject(scope: AdapterScope): Promise<PyProject> {
  const parser = await parserFor("python");
  const cache = new Map<string, PyFile | null>();
  const trees: { delete(): void }[] = [];

  const file = (path: string): PyFile | null => {
    if (cache.has(path)) return cache.get(path)!;
    const text = path.endsWith(".py") ? scope.read(path) : null;
    let f: PyFile | null = null;
    if (text !== null) {
      const tree = parser.parse(text);
      trees.push(tree);
      f = { path, root: tree.rootNode, defs: definitionsOf(tree.rootNode), bindings: bindingsOf(path, tree.rootNode, scope) };
    }
    cache.set(path, f);
    return f;
  };

  const byName = (path: string, name: string, depth: number): PyTarget | null => {
    const f = file(path);
    if (!f || depth > 8) return null;
    if (f.defs.has(name)) return { file: path, name };
    const b = f.bindings.get(name);
    if (!b || "external" in b) return null;
    // A re-export: `from .users import router` in a package's __init__.py.
    return b.symbol === null ? { file: b.file, name: null } : byName(b.file, b.symbol, depth + 1);
  };

  const resolve = (path: string, node: SyntaxNode, depth = 0): PyTarget | null => {
    const f = file(path);
    if (!f || depth > 8) return null;
    if (node.type === "identifier") return byName(path, node.text, depth);
    if (node.type === "attribute") {
      // `import app.routers.users` binds the whole dotted name.
      const dotted = f.bindings.get(node.childForFieldName("object")?.text ?? "");
      const attr = node.childForFieldName("attribute")?.text;
      if (!attr) return null;
      if (dotted && !("external" in dotted) && dotted.symbol === null) return byName(dotted.file, attr, depth + 1);
      const object = node.childForFieldName("object");
      const base = object ? resolve(path, object, depth + 1) : null;
      return base && base.name === null ? byName(base.file, attr, depth + 1) : null;
    }
    return null;
  };

  const externalCallee = (path: string, call: SyntaxNode): string | null => {
    const f = file(path);
    const fn = call.childForFieldName("function");
    if (!f || !fn) return null;
    if (fn.type === "identifier") {
      const b = f.bindings.get(fn.text);
      return b && "external" in b ? b.external : null;
    }
    if (fn.type === "attribute") {
      const b = f.bindings.get(fn.childForFieldName("object")?.text ?? "");
      const attr = fn.childForFieldName("attribute")?.text;
      return b && "external" in b && attr ? `${b.external}.${attr}` : null;
    }
    return null;
  };

  return {
    file,
    resolve,
    externalCallee,
    done() {
      for (const t of trees) t.delete();
      parser.delete();
    },
  };
}

/** The keyword argument `name`, else positional argument `index` (null: keyword only). */
export function pyArg(call: SyntaxNode, index: number | null, name: string | null): SyntaxNode | null {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (name !== null) {
    const kw = args.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name);
    if (kw) return kw.childForFieldName("value");
  }
  const positional = args.filter((a) => a.type !== "keyword_argument" && a.type !== "list_splat" && a.type !== "dictionary_splat");
  return index === null ? null : positional[index] ?? null;
}

/** Whether the call has a keyword argument of that name. */
export function pyHasKeyword(call: SyntaxNode, name: string): boolean {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).some(
    (a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name,
  );
}

/** A list or tuple of plain strings, or null if any element is computed. */
export function pyStrings(node: SyntaxNode | null): string[] | null {
  if (!node || (node.type !== "list" && node.type !== "tuple")) return null;
  const out: string[] = [];
  for (const e of node.namedChildren) {
    const s = plainString(e);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

const CONDITIONAL = new Set([
  "if_statement", "elif_clause", "else_clause", "for_statement", "while_statement",
  "try_statement", "except_clause", "match_statement", "case_clause", "conditional_expression",
]);

/** Whether a node sits under a branch or loop within its function or module: whether it exists depends on running it. */
export function pyConditional(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "function_definition" || p.type === "class_definition") return false;
    if (CONDITIONAL.has(p.type)) return true;
  }
  return false;
}
