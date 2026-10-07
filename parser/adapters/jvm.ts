import type { AdapterScope } from "../adapter.ts";
import { parserFor, type SyntaxNode } from "../languages/tree-sitter.ts";
import { plainString } from "./shared.ts";

// Annotated classes, read the same way from Java and Kotlin, so the
// annotation-routed frameworks (Spring, JAX-RS, Micronaut) work on either.
// Only what's written literally becomes a value; anything else is "other",
// and the adapters withhold what depends on it.

export type Value =
  | { kind: "string"; value: string }
  | { kind: "array"; items: Value[] }
  /** RequestMethod.GET, HttpMethod.POST: the name as written. */
  | { kind: "ref"; name: string }
  | { kind: "other" };

export type Annotation = { name: string; line: number; positional: Value[]; named: Map<string, Value> };
export type JvmMethod = { name: string; line: number; annotations: Annotation[] };
export type JvmClass = { file: string; name: string; interface: boolean; annotations: Annotation[]; methods: JvmMethod[] };

/** Strings in a value: one, or an array of them; null if any isn't plain. */
export function strings(v: Value | undefined): string[] | null {
  if (!v) return null;
  if (v.kind === "string") return [v.value];
  if (v.kind !== "array") return null;
  const out: string[] = [];
  for (const i of v.items) {
    if (i.kind !== "string") return null;
    out.push(i.value);
  }
  return out;
}

/** Refs in a value: RequestMethod.GET or [RequestMethod.GET, ...], by their last name; null if any isn't one. */
export function refs(v: Value | undefined): string[] | null {
  if (!v) return null;
  const items = v.kind === "array" ? v.items : [v];
  const out: string[] = [];
  for (const i of items) {
    if (i.kind !== "ref") return null;
    out.push(i.name.slice(i.name.lastIndexOf(".") + 1));
  }
  return out;
}

const lastName = (s: string) => s.slice(s.lastIndexOf(".") + 1);

// ------------------------------------------------------------------ Java

function javaValue(n: SyntaxNode | null | undefined): Value {
  if (!n) return { kind: "other" };
  if (n.type === "string_literal") {
    const s = plainString(n);
    return s === null ? { kind: "other" } : { kind: "string", value: s };
  }
  if (n.type === "element_value_array_initializer") return { kind: "array", items: n.namedChildren.map(javaValue) };
  if (n.type === "field_access" || n.type === "identifier") return { kind: "ref", name: n.text };
  return { kind: "other" };
}

function javaAnnotations(node: SyntaxNode): Annotation[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  return (mods?.namedChildren ?? [])
    .filter((a) => a.type === "annotation" || a.type === "marker_annotation")
    .map((a) => {
      const positional: Value[] = [];
      const named = new Map<string, Value>();
      for (const c of a.childForFieldName("arguments")?.namedChildren ?? []) {
        if (c.type === "element_value_pair") named.set(c.childForFieldName("key")?.text ?? "", javaValue(c.childForFieldName("value")));
        else positional.push(javaValue(c));
      }
      return { name: lastName(a.childForFieldName("name")?.text ?? ""), line: a.startPosition.row + 1, positional, named };
    });
}

function javaClasses(file: string, root: SyntaxNode): JvmClass[] {
  return root.descendantsOfType(["class_declaration", "interface_declaration"]).map((c) => ({
    file,
    name: c.childForFieldName("name")?.text ?? "",
    interface: c.type === "interface_declaration",
    annotations: javaAnnotations(c),
    methods: (c.childForFieldName("body")?.namedChildren ?? [])
      .filter((m) => m.type === "method_declaration")
      .map((m) => ({ name: m.childForFieldName("name")?.text ?? "", line: m.startPosition.row + 1, annotations: javaAnnotations(m) })),
  }));
}

// ---------------------------------------------------------------- Kotlin

function kotlinString(n: SyntaxNode): string | null {
  // "$x" and "${x}" templates, and escapes, aren't plain.
  if (n.namedChildren.some((c) => c.type !== "string_content")) return null;
  if (n.text.startsWith('"""') || n.text.includes("\\")) return null;
  return n.namedChildren.map((c) => c.text).join("");
}

function kotlinValue(n: SyntaxNode | null | undefined): Value {
  if (!n) return { kind: "other" };
  if (n.type === "string_literal") {
    const s = kotlinString(n);
    return s === null ? { kind: "other" } : { kind: "string", value: s };
  }
  if (n.type === "collection_literal") return { kind: "array", items: n.namedChildren.map(kotlinValue) };
  // arrayOf("a", "b")
  if (n.type === "call_expression" && n.namedChildren[0]?.text === "arrayOf") {
    const args = n.namedChildren[1]?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
    return { kind: "array", items: args.map((a) => kotlinValue(a.namedChildren[a.namedChildren.length - 1])) };
  }
  if (n.type === "navigation_expression" || n.type === "simple_identifier") return { kind: "ref", name: n.text };
  return { kind: "other" };
}

function kotlinAnnotations(node: SyntaxNode): Annotation[] {
  const mods = node.namedChildren.find((c) => c.type === "modifiers");
  return (mods?.namedChildren ?? [])
    .filter((a) => a.type === "annotation")
    .map((a) => {
      const inv = a.namedChildren.find((c) => c.type === "constructor_invocation");
      const type = (inv ?? a).namedChildren.find((c) => c.type === "user_type")?.text ?? "";
      const positional: Value[] = [];
      const named = new Map<string, Value>();
      for (const arg of inv?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? []) {
        const kids = arg.namedChildren;
        if (kids.length === 2 && kids[0].type === "simple_identifier") named.set(kids[0].text, kotlinValue(kids[1]));
        else positional.push(kotlinValue(kids[kids.length - 1]));
      }
      return { name: lastName(type), line: a.startPosition.row + 1, positional, named };
    });
}

function kotlinClasses(file: string, root: SyntaxNode): JvmClass[] {
  return root.descendantsOfType(["class_declaration", "object_declaration"]).map((c) => ({
    file,
    name: c.namedChildren.find((x) => x.type === "type_identifier")?.text ?? "",
    interface: c.children.some((x) => x.type === "interface"),
    annotations: kotlinAnnotations(c),
    methods: (c.namedChildren.find((x) => x.type === "class_body")?.namedChildren ?? [])
      .filter((m) => m.type === "function_declaration")
      .map((m) => ({ name: m.namedChildren.find((x) => x.type === "simple_identifier")?.text ?? "", line: m.startPosition.row + 1, annotations: kotlinAnnotations(m) })),
  }));
}

/**
 * Every annotated class in the owned Java and Kotlin files whose text
 * mentions `needle`. Files whose syntax didn't parse cleanly are returned
 * apart: positions in a broken tree can't be trusted to mean what they say.
 */
export async function jvmClasses(scope: AdapterScope, needle: RegExp): Promise<{ classes: JvmClass[]; broken: string[] }> {
  const classes: JvmClass[] = [];
  const broken: string[] = [];
  for (const [ext, grammar, read] of [[".java", "java", javaClasses], [".kt", "kotlin", kotlinClasses]] as const) {
    const files = scope.owned.filter((f) => f.path.endsWith(ext));
    if (files.length === 0) continue;
    const parser = await parserFor(grammar);
    try {
      for (const f of files) {
        const text = scope.read(f.path);
        if (text === null || !needle.test(text)) continue;
        const tree = parser.parse(text);
        try {
          if (tree.rootNode.hasError) broken.push(f.path);
          else classes.push(...read(f.path, tree.rootNode));
        } finally {
          tree.delete();
        }
      }
    } finally {
      parser.delete();
    }
  }
  return { classes, broken };
}

/**
 * Path parts joined the way these frameworks do: a leading slash added to
 * each, one between them. A doubled or trailing slash is left unread; "/"
 * written anywhere with nothing else is the root; nothing written is unread.
 */
export function joinPaths(parts: readonly string[]): string | null {
  const segs: string[] = [];
  for (const raw of parts) {
    const p = raw.startsWith("/") ? raw.slice(1) : raw;
    if (p === "") continue;
    if (p.includes("//") || p.endsWith("/")) return null;
    segs.push(p);
  }
  if (segs.length === 0) return parts.includes("/") ? "/" : null;
  return `/${segs.join("/")}`;
}

/**
 * A server prefix set in application properties under one of `keys`: "" if
 * unset, the value if it's one plain value everywhere, or why not. YAML that
 * mentions any of `yamlHints` isn't parsed, so its prefix is unknown.
 */
export function propertiesPrefix(scope: AdapterScope, keys: readonly string[], yamlHints: RegExp): { value: string } | { reason: string; where: string } {
  const values = new Map<string, string>();
  for (const f of scope.files) {
    if (!scope.roots.some((r) => r === "" || f.path.startsWith(`${r}/`))) continue;
    const name = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (/^application.*\.ya?ml$/.test(name) && yamlHints.test(scope.read(f.path) ?? "")) {
      return { reason: "a path prefix is set in YAML configuration, which isn't read", where: f.path };
    }
    if (!/^application.*\.properties$/.test(name)) continue;
    for (const line of (scope.read(f.path) ?? "").split("\n")) {
      const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
      if (m && keys.includes(m[1])) values.set(`${f.path}\n${m[1]}`, m[2]);
    }
  }
  const distinct = new Set(values.values());
  if (distinct.size === 0) return { value: "" };
  // Profiles can set it differently; one value everywhere is certain.
  if (distinct.size > 1 || [...distinct][0].includes("$")) {
    return { reason: "the path prefix differs between configuration files or uses a placeholder", where: [...values.keys()][0].split("\n")[0] };
  }
  return { value: [...distinct][0] };
}
