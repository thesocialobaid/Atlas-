import { fanCounts } from "../parser/graph.ts";
import { parseCoverage, parseEdge, parseImportRecord, parseRepoFile, parseRoute, parseWithheld } from "../parser/read.ts";
import type { Route } from "../parser/types.ts";
import { categoryOf } from "./map/categories.ts";
import { fold } from "./map/fold.ts";
import type { MapInput } from "./map/input.ts";
import type { FileToExplain, FolderToExplain } from "./ai/explain.ts";
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
      "id, project_id, status, stage, stage_message, error, commit_sha, created_at, progressed_at, finished_at, coverage, adapter, adapters, routes_withheld, links_skipped, label_note, project:projects(repo_owner, repo_name)",
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
      .select(
        "id, path, folder, language, lines, bytes, sha256, module, status, skip_reason, had_syntax_errors, file_roles(role, framework), routes(framework, method, path, line)",
      )
      .eq("analysis_id", id)
      .order("path")
      .range(from, to),
  );
  const pathOf = new Map<string, string>();
  const routes: Route[] = [];
  const files = fileRows.map((f, i) => {
    pathOf.set(f.id, f.path);
    f.routes.forEach((r, j) =>
      routes.push(
        parseRoute({ framework: r.framework, file: f.path, method: r.method, path: r.path, line: r.line }, `files[${i}].routes[${j}]`),
      ),
    );
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
        framework: f.file_roles[0]?.framework ?? null,
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
    // Stored before several frameworks could apply: one adapter name, "none" for no framework.
    adapters:
      analysis.adapters ??
      (analysis.adapter === null
        ? fail("the analysis", "it finished without recording its frameworks")
        : analysis.adapter === "none"
          ? []
          : [analysis.adapter]),
    routes,
    labelNote: analysis.label_note,
    // Null when the analysis was stored before routes were read: the map
    // says so rather than showing an empty table as if there were none.
    routesWithheld:
      analysis.routes_withheld === null
        ? null
        : Array.isArray(analysis.routes_withheld)
          ? analysis.routes_withheld.map((g, i) => parseWithheld(g, `routes_withheld[${i}]`))
          : fail("the analysis", "its withheld routes aren't a list"),
  };
  return { analysis, input };
}

/**
 * Everything handed to the model to explain one file: its stored row and its
 * neighbours, taken from the stored edges and nothing else. Null when the
 * analysis or the file isn't readable to this organization.
 */
export async function getFileToExplain(analysisId: string, path: string) {
  const analysis = await getAnalysis(analysisId);
  if (!analysis || analysis.status !== "complete" || !analysis.project || !analysis.commit_sha) return null;
  const db = createSupabase();
  const { data: file, error } = await db
    .from("files")
    .select("id, path, sha256, language, lines, file_roles(role)")
    .eq("analysis_id", analysisId)
    .eq("path", path)
    .maybeSingle();
  if (error) fail("the file", error.message);
  if (!file) return null;

  const [out, into] = await Promise.all([
    everyRow("imports of the file", (from, to) =>
      db.from("edges").select("id, to_file_id").eq("from_file_id", file.id).order("id").range(from, to),
    ),
    everyRow("importers of the file", (from, to) =>
      db.from("edges").select("id, from_file_id").eq("to_file_id", file.id).order("id").range(from, to),
    ),
  ]);
  const ids = [...new Set([...out.map((e) => e.to_file_id), ...into.map((e) => e.from_file_id)])];
  const pathOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: e } = await db.from("files").select("id, path").in("id", ids.slice(i, i + 200)).limit(200);
    if (e) fail("the file's neighbours", e.message);
    for (const row of data) pathOf.set(row.id, row.path);
  }
  const paths = (list: string[]) =>
    [...new Set(list.map((id) => pathOf.get(id) ?? fail("the file's neighbours", `no file ${id}`)))].sort();

  const explain: FileToExplain = {
    path: file.path,
    sha256: file.sha256,
    language: file.language,
    role: file.file_roles[0]?.role ?? null,
    imports: paths(out.map((e) => e.to_file_id)),
    importedBy: paths(into.map((e) => e.from_file_id)),
  };
  return {
    explain,
    binary: file.lines === null,
    repo: { owner: analysis.project.repo_owner, name: analysis.project.repo_name },
    commit: analysis.commit_sha,
  };
}

/**
 * Everything handed to the model to explain a folded folder: the files drawn
 * in its box (the same fold the map draws, recomputed from the stored files)
 * and every stored edge that crosses its boundary.
 */
export async function getFolderToExplain(analysisId: string, dir: string): Promise<FolderToExplain | null> {
  const analysis = await getAnalysis(analysisId);
  if (!analysis || analysis.status !== "complete") return null;
  const db = createSupabase();
  const files = await everyRow("files", (from, to) =>
    db
      .from("files")
      .select("id, path, folder, language, lines, sha256, file_roles(role)")
      .eq("analysis_id", analysisId)
      .order("path")
      .range(from, to),
  );
  const members = fold(files).groups.get(dir);
  if (!members) return null;
  const inside = new Set(members);
  const pathOf = new Map(files.map((f) => [f.id, f.path]));
  const edges = await everyRow("edges", (from, to) =>
    db.from("edges").select("id, from_file_id, to_file_id").eq("analysis_id", analysisId).order("id").range(from, to),
  );

  // One row per file pair: an import and a re-export of the same file are one connection here.
  const crossing = (wantFromInside: boolean) => {
    const seen = new Set<string>();
    const out: { from: string; to: string }[] = [];
    for (const e of edges) {
      const from = pathOf.get(e.from_file_id) ?? fail("edges", `no file ${e.from_file_id}`);
      const to = pathOf.get(e.to_file_id) ?? fail("edges", `no file ${e.to_file_id}`);
      if (inside.has(from) !== wantFromInside || inside.has(to) === wantFromInside) continue;
      const key = `${from}
${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to });
    }
    return out.sort((a, b) => (a.to + a.from < b.to + b.from ? -1 : 1));
  };

  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    dir,
    files: members.map((p) => {
      const f = byPath.get(p)!;
      return { path: p, sha256: f.sha256, kind: f.file_roles[0]?.role ?? categoryOf(f), lines: f.lines };
    }),
    incoming: crossing(false),
    outgoing: crossing(true),
  };
}
