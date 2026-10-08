// Explaining a file and explaining a folded folder. The model is handed
// everything it may mention and asked to explain it; it never decides what's
// connected. Every neighbour comes from the parser's resolved edges, and
// every path in its answer that isn't one of them is the model's invention,
// which is what the next phase measures.
//
// Plain server code: no Next, no React, runnable from a script.

import { readCache, writeCache, cacheKey, type Db } from "./cache.ts";
import { chat, MODEL, traced } from "./client.ts";

/**
 * Bumped whenever a prompt changes, so answers written under the old one
 * stop being served. Part of every key.
 */
const FILE_PROMPT_VERSION = 1;
const FOLDER_PROMPT_VERSION = 1;

/** The source handed to the model, at most. A longer file is cut and the model told so. */
const MAX_SOURCE_LINES = 600;
const MAX_SOURCE_CHARS = 40_000;

/** Connections listed in full up to this many; past it, the rest are counted. */
const MAX_LISTED = 300;

// Exactly three pieces of formatting are allowed, and rendered: inline code,
// bold and bullets. Forbidding formatting outright doesn't hold (models add
// it anyway, and it shows up as raw symbols), and headings cut a narrow pane
// into labelled fragments.
const FORMAT = `Formatting: you may use \`inline code\`, **bold**, and bullet lines that start with "- ". Use nothing else: no headings, no numbered lists, no tables, no links, no italics.`;

const SHARED_RULES = `- When you mention a file, write its full path exactly as it's listed.
- Mention only files listed here. Never say or suggest that any other file is connected to, imported by or used by these.
- Explain; don't evaluate. No ratings, no problems found, no suggested improvements.
- ${FORMAT}`;

const FILE_SYSTEM = `You explain one file of a code repository to a developer reading a map of its dependencies.

You're given the file's path and source, and two lists a parser produced: the repository files it imports, and the repository files that import it. Those lists are complete and exact.

Write one to three short paragraphs: what this file does, and the part it plays among those neighbours. Name the neighbours that matter to that story.

${SHARED_RULES}`;

const FOLDER_SYSTEM = `You explain one folder of a code repository to a developer reading a map of its dependencies.

You're given every file the folder holds and every import that crosses its boundary, as a parser found them. Those lists are complete and exact unless a count says some were left out.

Write one to three short paragraphs about the folder as a whole: what it holds, and why the files outside it that import it depend on it. This is about the folder, not any one file in it.

${SHARED_RULES}`;

export type Explained = { body: string; cached: boolean };

export type FileToExplain = {
  path: string;
  /** The content hash stored at analysis time. Fetched source must match it. */
  sha256: string;
  language: string;
  role: string | null;
  imports: string[];
  importedBy: string[];
};

function listed(paths: string[]): string {
  if (paths.length === 0) return "(none)";
  const shown = paths.slice(0, MAX_LISTED).map((p) => `- ${p}`);
  if (paths.length > MAX_LISTED) shown.push(`(and ${paths.length - MAX_LISTED} more, not listed)`);
  return shown.join("\n");
}

function excerpt(text: string): string {
  const lines = text.split("\n");
  let cut = lines.slice(0, MAX_SOURCE_LINES).join("\n");
  if (cut.length > MAX_SOURCE_CHARS) cut = cut.slice(0, MAX_SOURCE_CHARS);
  const whole = cut.length === text.length;
  return whole ? text : `${cut}\n[source cut here: the file has ${lines.length} lines, only the start is shown]`;
}

async function ask(system: string, user: string): Promise<string> {
  const res = await chat().chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const body = res.choices[0]?.message.content?.trim();
  if (!body) throw new Error("The model returned an empty answer.");
  return body;
}

/**
 * Explains a file. The cache is read first, inside this traced call; on a
 * miss the source is read (through `readSource`, which must return text whose
 * hash is the stored one) and the model asked.
 */
export async function explainFile(
  db: Db,
  orgId: string,
  file: FileToExplain,
  readSource: (path: string) => Promise<string>,
): Promise<Explained> {
  const run = traced("explain file", async (f: FileToExplain): Promise<Explained> => {
    // The stored hash stands for the source, so a hit needs no fetch.
    const key = cacheKey("file", FILE_PROMPT_VERSION, f);
    const hit = (await readCache(db, [key])).get(key);
    if (hit !== undefined) return { body: hit, cached: true };

    const source = await traced("read source", async (path: string) => ({ text: await readSource(path) }), "tool")(f.path);
    const user = [
      `File: ${f.path}`,
      `Language: ${f.language}${f.role ? `\nRole: ${f.role}` : ""}`,
      `Repository files it imports:\n${listed(f.imports)}`,
      `Repository files that import it:\n${listed(f.importedBy)}`,
      `Source:\n${excerpt(source.text)}`,
    ].join("\n\n");
    const body = await ask(FILE_SYSTEM, user);
    await writeCache(db, orgId, "file", [{ key, body }]);
    return { body, cached: false };
  });
  return run(file);
}

export type FolderToExplain = {
  dir: string;
  /** Every file drawn inside the folder's box, with its content hash. */
  files: { path: string; sha256: string; kind: string; lines: number | null }[];
  /** Imports from outside the folder into it, "from → to". */
  incoming: { from: string; to: string }[];
  /** Imports from inside the folder out of it. */
  outgoing: { from: string; to: string }[];
};

/** Explains a folded folder: what's in it, and why so much points at it. */
export async function explainFolder(db: Db, orgId: string, folder: FolderToExplain): Promise<Explained> {
  const run = traced("explain folder", async (f: FolderToExplain): Promise<Explained> => {
    const key = cacheKey("folder", FOLDER_PROMPT_VERSION, f);
    const hit = (await readCache(db, [key])).get(key);
    if (hit !== undefined) return { body: hit, cached: true };

    const pairs = (list: { from: string; to: string }[]) => listed(list.map((e) => `${e.from} → ${e.to}`));
    const user = [
      `Folder: ${f.dir === "." ? "the repository root" : `${f.dir}/`}`,
      `Files in it (${f.files.length}):\n${listed(f.files.map((x) => `${x.path} (${x.kind}${x.lines === null ? "" : `, ${x.lines} lines`})`))}`,
      `Imports from outside the folder into it (${f.incoming.length}):\n${pairs(f.incoming)}`,
      `Imports from inside the folder to files outside it (${f.outgoing.length}):\n${pairs(f.outgoing)}`,
    ].join("\n\n");
    const body = await ask(FOLDER_SYSTEM, user);
    await writeCache(db, orgId, "folder", [{ key, body }]);
    return { body, cached: false };
  });
  return run(folder);
}
