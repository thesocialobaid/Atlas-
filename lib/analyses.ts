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
      "id, status, error, created_at, finished_at, project:projects(repo_owner, repo_name)",
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
      "id, repo_owner, repo_name, analyses(status, created_at, finished_at)",
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
