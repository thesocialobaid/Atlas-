// Roles for files no convention recognised. The model may only answer with a
// role that isn't structural: page, route and controller decide the route
// table and the entry-point colouring, and only convention may assign them.
// That's enforced here, not asked of the model: an answer outside the list
// is dropped, and the file stays unlabelled rather than approximately so.
//
// Plain server code: no Next, no React, runnable from a script.

import { readCache, writeCache, cacheKey, type Db } from "./cache.ts";
import { LABEL, type LabelRole } from "../../parser/adapters/taxonomy.ts";
import { chat, MODEL, traced } from "./client.ts";

const isLabelRole = (v: unknown): v is LabelRole => LABEL.some((r) => r.role === v);

/** Bumped whenever the prompt changes. */
const LABEL_PROMPT_VERSION = 1;

/** Files per model call: few calls on the free tier's per-minute limit, short enough to answer reliably. */
const BATCH = 40;

/** Lines of each file shown: enough to see what it declares, cheap enough to send forty at once. */
export const LABEL_HEAD_LINES = 40;

/** Cached for a file the model wasn't sure about, so it isn't asked again. */
const NONE = "none";

const SYSTEM = `You label files in a code repository with the role each plays. For each file you're given its path and its first lines.

Answer with exactly one of these roles per file, or "none":
- service: business logic or an integration other code calls
- repository: reads and writes stored data
- model: a data shape, schema, type or entity definition
- util: small general-purpose helpers
- config: configuration or settings
- component: a UI component
- hook: a UI framework hook (a React hook, a Vue composable)

Answer "none" when no role fits or you aren't sure. A wrong role is worse than none.

Reply with JSON only, in this shape: {"labels": [{"path": "<path exactly as given>", "role": "<role or none>"}]}`;

export type ToLabel = { path: string; sha256: string; head: string };

export type Labelled = {
  roles: Map<string, LabelRole>;
  /** Files the model answered "none" for, or answered with something not allowed. */
  unsure: number;
  /** Files never answered for, and why. Null when every batch was answered. */
  failed: { count: number; reason: string } | null;
};

function parseLabels(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return out;
  }
  const labels = typeof parsed === "object" && parsed !== null && "labels" in parsed ? parsed.labels : null;
  if (!Array.isArray(labels)) return out;
  for (const l of labels) {
    if (typeof l === "object" && l !== null && "path" in l && "role" in l && typeof l.path === "string" && typeof l.role === "string") {
      out.set(l.path, l.role);
    }
  }
  return out;
}

/**
 * One question to the model: a role per file, exactly as answered, keyed by
 * the path it answered for. Not every answer is an allowed role; callers
 * decide what one outside the list means. The role eval asks through this
 * too, so it measures the prompt the pipeline sends.
 */
export async function askRoles(files: { path: string; head: string }[]): Promise<Map<string, string>> {
  const res = await chat().chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: files.map((f) => `=== ${f.path}\n${f.head}`).join("\n\n") },
    ],
  });
  return parseLabels(res.choices[0]?.message.content ?? "");
}

/**
 * Labels files in batches, reading the cache first. Partial results are kept
 * when a batch fails: every label returned is a valid one, and the rest are
 * counted with the reason.
 */
export async function labelFiles(db: Db, orgId: string, files: ToLabel[]): Promise<Labelled> {
  const result: Labelled = { roles: new Map(), unsure: 0, failed: null };
  if (files.length === 0) return result;
  const byPath = new Map(files.map((f) => [f.path, f]));

  // Only the paths are recorded as the trace's input; the file heads would
  // bury them.
  const run = traced("label files", async (paths: string[]): Promise<{ labelled: number; unsure: number; failed: number }> => {
    const asked = paths.map((p) => byPath.get(p)!);
    const keyOf = new Map(asked.map((f) => [f.path, cacheKey("label", LABEL_PROMPT_VERSION, { path: f.path, sha256: f.sha256 })]));
    const cached = await readCache(db, orgId, [...keyOf.values()]);
    const record = (path: string, role: string) => {
      if (isLabelRole(role)) result.roles.set(path, role);
      else result.unsure++;
    };
    const misses: ToLabel[] = [];
    for (const f of asked) {
      const hit = cached.get(keyOf.get(f.path)!);
      if (hit === undefined) misses.push(f);
      else record(f.path, hit);
    }

    for (let i = 0; i < misses.length; i += BATCH) {
      const batch = misses.slice(i, i + BATCH);
      let answers: Map<string, string>;
      try {
        answers = await askRoles(batch);
      } catch (e) {
        result.failed = { count: misses.length - i, reason: e instanceof Error ? e.message : String(e) };
        break;
      }
      const rows: { key: string; body: string }[] = [];
      for (const f of batch) {
        // A path the model didn't answer for, or answered under another name,
        // gets nothing: it's left unlabelled and counted as unsure.
        const answer = answers.get(f.path);
        const role = answer !== undefined && isLabelRole(answer) ? answer : NONE;
        record(f.path, role);
        if (answer !== undefined) rows.push({ key: keyOf.get(f.path)!, body: role });
      }
      await writeCache(db, orgId, "label", rows);
    }
    return { labelled: result.roles.size, unsure: result.unsure, failed: result.failed?.count ?? 0 };
  });

  await run(files.map((f) => f.path));
  return result;
}
