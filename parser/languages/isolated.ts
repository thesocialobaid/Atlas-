import { enginePaths } from "./tree-sitter.ts";

// Some grammars can't run in this process. The Swift grammar crashes V8's
// optimising WebAssembly compiler (a "Fatal process out of memory: Zone"
// abort, not an exception) on ordinary input, and that would take down the
// whole server. V8 only avoids it when started with --liftoff-only, which
// can't be switched on after start. So those grammars parse in a child Node
// process started with that flag, which hands back each syntax tree as plain
// data. If the child dies, only it dies; the caller gets the reason.

/** A syntax node read back from the child: the parts of a tree-sitter node adapters use. */
export type DataNode = {
  type: string;
  /** Source text; empty for nodes longer than TEXT_LIMIT, which nothing reads whole. */
  text: string;
  startPosition: { row: number };
  startIndex: number;
  field: string | null;
  /** True when the parser recovered from syntax errors at or under this node. */
  hasError: boolean;
  parent: DataNode | null;
  namedChildren: DataNode[];
  childForFieldName(name: string): DataNode | null;
  descendantsOfType(type: string | readonly string[]): DataNode[];
};

type Raw = { t: string; x: string; r: number; s: number; f: string | null; c: Raw[]; e: boolean };

const TEXT_LIMIT = 400;

// Runs in the child: loads the engine and grammar from the paths given,
// parses each file from stdin, writes the named nodes back as JSON.
const WORKER = `
import { createRequire } from "node:module";
const require = createRequire(process.env.ATLAS_ENGINE);
const Parser = require(process.env.ATLAS_ENGINE);
await Parser.init();
const language = await Parser.Language.load(process.env.ATLAS_GRAMMAR);
const parser = new Parser();
parser.setLanguage(language);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const out = {};
for (const { path, text } of JSON.parse(input)) {
  const tree = parser.parse(text);
  const cursor = tree.walk();
  const read = () => {
    const node = cursor.currentNode;
    const raw = { t: node.type, x: node.endIndex - node.startIndex <= ${TEXT_LIMIT} ? node.text : "", r: node.startPosition.row, s: node.startIndex, f: cursor.currentFieldName || null, c: [], e: node.hasError };
    if (cursor.gotoFirstChild()) {
      do { if (cursor.nodeIsNamed) raw.c.push(read()); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
    return raw;
  };
  out[path] = read();
  cursor.delete();
  tree.delete();
}
process.stdout.write(JSON.stringify(out));
`;

function revive(raw: Raw, parent: DataNode | null): DataNode {
  const node: DataNode = {
    type: raw.t,
    text: raw.x,
    startPosition: { row: raw.r },
    startIndex: raw.s,
    field: raw.f,
    hasError: raw.e,
    parent,
    namedChildren: [],
    childForFieldName: (name) => node.namedChildren.find((c) => c.field === name) ?? null,
    descendantsOfType(type) {
      const types = typeof type === "string" ? [type] : type;
      const out: DataNode[] = [];
      const visit = (n: DataNode) => {
        for (const c of n.namedChildren) {
          if (types.includes(c.type)) out.push(c);
          visit(c);
        }
      };
      visit(node);
      return out;
    },
  };
  node.namedChildren = raw.c.map((c) => revive(c, node));
  return node;
}

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && "t" in v && "c" in v && Array.isArray(v.c);
}

/** Parses files with a grammar in a separate process. A failure of that process is returned, not thrown. */
export async function parseIsolated(
  grammar: string,
  files: readonly { path: string; text: string }[],
): Promise<{ trees: Map<string, DataNode> } | { error: string }> {
  if (files.length === 0) return { trees: new Map() };
  const { spawn } = process.getBuiltinModule("node:child_process");
  const paths = enginePaths(grammar);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--liftoff-only", "--input-type=module", "-e", WORKER], {
      env: { ...process.env, ATLAS_ENGINE: paths.engine, ATLAS_GRAMMAR: paths.grammar },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-400)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: `the ${grammar} parser process couldn't start: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: `the ${grammar} parser process stopped (${signal ?? `exit ${code}`})${err ? `: ${err.trim().split("\n")[0]}` : ""}` });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(out).toString("utf8"));
        const trees = new Map<string, DataNode>();
        if (typeof parsed === "object" && parsed !== null) {
          for (const [path, raw] of Object.entries(parsed)) if (isRaw(raw)) trees.set(path, revive(raw, null));
        }
        resolve({ trees });
      } catch (e) {
        resolve({ error: `the ${grammar} parser process returned something unreadable: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
    child.stdin.end(JSON.stringify(files));
  });
}
