// What the evals read: stored analyses, through the pipeline's client, and
// file text from GitHub at the analysed commit, checked against the stored
// hash so a dataset holds exactly the files the analyses were made from.
//
// The pipeline's client holds the secret key and bypasses the row policies,
// so every query here names the analysis it means. That's the same
// allowance lib/pipeline has, for the same reason: this isn't serving a
// member, it's reading the store from a terminal.

import { createPipelineDb, type PipelineDb } from "../lib/pipeline/db.ts";
import { readFileAt, type RepoRef } from "../lib/pipeline/github.ts";
import { tracingStatus } from "../lib/ai/client.ts";

/** Evals write experiments to LangSmith; without tracing there's nowhere to put them. */
export function requireTracing(): void {
  const t = tracingStatus();
  if (!t.on) throw new Error(`Evals need LangSmith, and tracing is off: ${t.reason}.`);
}

export type Analysis = { id: string; repo: RepoRef; commit: string };

/** The newest complete analysis of each repository: older ones are the same files again. */
export async function latestAnalyses(db: PipelineDb): Promise<Analysis[]> {
  const { data, error } = await db
    .from("analyses")
    .select("id, commit_sha, created_at, project_id, project:projects(repo_owner, repo_name)")
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Couldn't read analyses: ${error.message}`);
  const seen = new Set<string>();
  const out: Analysis[] = [];
  for (const a of data) {
    if (seen.has(a.project_id) || !a.project || !a.commit_sha) continue;
    seen.add(a.project_id);
    out.push({ id: a.id, repo: { owner: a.project.repo_owner, name: a.project.repo_name }, commit: a.commit_sha });
  }
  return out;
}

const PAGE = 1000;

/** Every row a paged query returns, a page at a time. */
async function everyRow<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Couldn't read ${what}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

export type StoredFile = {
  id: string;
  path: string;
  sha256: string;
  language: string;
  lines: number | null;
  status: string;
  role: { role: string; framework: string; source: string } | null;
};

export async function filesOf(db: PipelineDb, analysisId: string): Promise<StoredFile[]> {
  const rows = await everyRow("files", (from, to) =>
    db
      .from("files")
      .select("id, path, sha256, language, lines, status, file_roles(role, framework, source)")
      .eq("analysis_id", analysisId)
      .order("path")
      .range(from, to),
  );
  return rows.map(({ file_roles, ...f }) => ({ ...f, role: file_roles[0] ?? null }));
}

export async function edgesOf(db: PipelineDb, analysisId: string): Promise<{ from: string; to: string }[]> {
  const rows = await everyRow("edges", (from, to) =>
    db.from("edges").select("id, from_file_id, to_file_id").eq("analysis_id", analysisId).order("id").range(from, to),
  );
  return rows.map((e) => ({ from: e.from_file_id, to: e.to_file_id }));
}

/** A file's text at the analysed commit, or null with the reason it can't be used. */
export async function textAt(a: Analysis, file: StoredFile): Promise<{ text: string } | { skipped: string }> {
  const got = await readFileAt(a.repo, a.commit, file.path);
  if (!got) return { skipped: "no longer on GitHub at that commit" };
  if (got.sha256 !== file.sha256) return { skipped: "on GitHub, but not the bytes that were analysed" };
  return { text: got.text };
}

export { createPipelineDb };

/**
 * Model calls from the evals, one at a time and spaced to stay under the free
 * tier's fifteen a minute. A 429 anyway (the app shares the quota) waits out
 * the minute once and tries again; a second one is a real failure and is
 * reported as one.
 */
const SPACING_MS = 4_500;
let last = 0;
let queue: Promise<unknown> = Promise.resolve();

export function paced<T>(call: () => Promise<T>): Promise<T> {
  const run = async () => {
    const attempt = async () => {
      const wait = last + SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return call();
    };
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof Error && "status" in e && e.status === 429)) throw e;
      await new Promise((r) => setTimeout(r, 60_000));
      return attempt();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x: unknown) => typeof x === "string");

/** The first line of an error, which is the part a person reads. */
export function firstLine(error: string): string {
  const line = error.split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
