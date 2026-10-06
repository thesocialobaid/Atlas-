import { fanCounts } from "../parser/graph.ts";
import { parseCoverage, parseEdge, parseImportRecord, parseRepoFile } from "../parser/read.ts";
import type { MapInput } from "./map/input.ts";
import { createSupabase } from "./supabase";

// None of these queries filter by organization: the row policy decides which
// rows come back. If another organization's row ever appears, the policy is
// wrong, not this file.

export const ANALYSIS_STATES = ["queued", "running", "complete", "failed"] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

const ACTIVITY_DAYS = 14;
const ACTIVITY_LIMIT = 1000;

function fail(what: string, message: string): never {
  throw new Error(`Couldn't load ${what}: ${message}`);
}

async function countAnalyses(state: AnalysisState) {
  const { count, error } = await createSupabase()
    .from("analyses")
    .select("id", { count: "exact", head: true })
    .eq("status", state);
  if (error) fail(`${state} analyses`, error.message);
  return count ?? 0;
}

async function countRepositories() {
  const { count, error } = await createSupabase()
    .from("projects")
    .select("id", { count: "exact", head: true });
  if (error) fail("repositories", error.message);
  return count ?? 0;
}

async function recentAnalyses() {
  const { data, error } = await createSupabase()
    .from("analyses")
    .select(
      "id, status, stage, stage_message, error, created_at, progressed_at, finished_at, project:projects(repo_owner, repo_name)",
    )
    .order("created_at", { ascending: false })
    .limit(8);
  if (error) fail("recent analyses", error.message);
  return data;
}

// Each repository with only its latest analysis embedded.
async function repositories() {
  const { data, error } = await createSupabase()
    .from("projects")
    .select(
      "id, repo_owner, repo_name, analyses(id, status, stage, created_at, progressed_at, finished_at)",
    )
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "analyses", ascending: false })
    .limit(1, { referencedTable: "analyses" })
    .limit(50);
  if (error) fail("repositories", error.message);
  return data;
}

async function activity(now: Date) {
  const since = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000);
  const { data, error } = await createSupabase()
    .from("analyses")
    .select("created_at, finished_at, status")
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false })
    .limit(ACTIVITY_LIMIT);
  if (error) fail("activity", error.message);
  return { rows: data, truncated: data.length === ACTIVITY_LIMIT };
}

export async function getDashboard(now: Date) {
  const [queued, running, complete, failed, repoCount, recent, repos, recentActivity] =
    await Promise.all([
      countAnalyses("queued"),
      countAnalyses("running"),
      countAnalyses("complete"),
      countAnalyses("failed"),
      countRepositories(),
      recentAnalyses(),
      repositories(),
      activity(now),
    ]);

  return {
    counts: { queued, running, complete, failed },
    repoCount,
    recent,
    repos,
    activity: recentActivity,
    activityDays: ACTIVITY_DAYS,
  };
}

export type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

/**
 * One analysis for its progress page. Null when it doesn't exist or belongs to
 * another organization: the policy hides both the same way, and so does this.
 */
export async function getAnalysis(id: string) {
  // Not a uuid can't be a row; asking would only be an error from Postgres.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const { data, error } = await createSupabase()
    .from("analyses")
    .select(
      "id, status, stage, stage_message, error, commit_sha, created_at, progressed_at, finished_at, coverage, adapter, links_skipped, project:projects(repo_owner, repo_name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) fail("the analysis", error.message);
  return data;
}

export type AnalysisRow = NonNullable<Awaited<ReturnType<typeof getAnalysis>>>;

/** Supabase returns at most this many rows per request, so lists are read in pages of it. */
const PAGE = 1000;

/**
 * Reads every row of one list, a page at a time, ordered so pages don't
 * overlap. Bounded by the analysis's own size: it ends when a page comes back
 * short, and it never re-reads.
 */
async function everyRow<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) fail(what, error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * One complete analysis, as the map reads it. Every row is checked by the
 * parser's own validators on the way out, the same checks a result file gets,
 * so the map never trusts a cast. Null when it doesn't exist, belongs to
 * another organization, or hasn't finished: there's no map until the run
 * has stored one.
 */
export async function getAnalysisMap(id: string) {
  const analysis = await getAnalysis(id);
  if (!analysis || analysis.status !== "complete") return null;
  const db = createSupabase();

  const fileRows = await everyRow("files", (from, to) =>
    db
      .from("files")
      .select("id, path, folder, language, lines, bytes, sha256, module, status, skip_reason, had_syntax_errors, file_roles(role)")
      .eq("analysis_id", id)
      .order("path")
      .range(from, to),
  );
  const pathOf = new Map<string, string>();
  const files = fileRows.map((f, i) => {
    pathOf.set(f.id, f.path);
    return parseRepoFile(
      {
        path: f.path,
        folder: f.folder,
        language: f.language,
        lines: f.lines,
        bytes: f.bytes,
        sha256: f.sha256,
        module: f.module,
        status: f.status,
        skipReason: f.skip_reason,
        hadSyntaxErrors: f.had_syntax_errors,
        // unique (file_id) on file_roles: at most one.
        role: f.file_roles[0]?.role ?? null,
      },
      `files[${i}]`,
    );
  });
  const path = (fileId: string, where: string) => pathOf.get(fileId) ?? fail(where, `no file ${fileId} in this analysis`);

  const edgeRows = await everyRow("edges", (from, to) =>
    db.from("edges").select("id, from_file_id, to_file_id, kind").eq("analysis_id", id).order("id").range(from, to),
  );
  const edges = edgeRows.map((e, i) =>
    parseEdge({ from: path(e.from_file_id, "edges"), to: path(e.to_file_id, "edges"), kind: e.kind }, `edges[${i}]`),
  );

  const importRows = await everyRow("imports", (from, to) =>
    db
      .from("imports")
      .select("id, from_file_id, specifier, kind, line, outcome, reason")
      .eq("analysis_id", id)
      .order("id")
      .range(from, to),
  );
  const imports = importRows.map((r, i) =>
    parseImportRecord(
      { from: path(r.from_file_id, "imports"), specifier: r.specifier, kind: r.kind, line: r.line, outcome: r.outcome, to: [], reason: r.reason },
      `imports[${i}]`,
    ),
  );

  const input: MapInput = {
    files,
    edges,
    imports,
    fan: fanCounts(
      files.map((f) => f.path),
      edges,
    ),
    coverage: parseCoverage(analysis.coverage),
    adapter: analysis.adapter ?? fail("the analysis", "it finished without recording an adapter"),
  };
  return { analysis, input };
}
