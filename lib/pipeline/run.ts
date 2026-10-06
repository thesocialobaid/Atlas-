// One analysis, start to finish: fetch, select, parse, store. Each stage is
// written to the analysis row as it begins, and a failure anywhere is caught
// at the top and written as a failed state with the stage it happened in, so
// no row is ever left saying "parsing" because the code that would have
// finished it threw.
//
// Plain server code: no Next, no React, runnable from a script.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles } from "../../parser/files.ts";
import { parseRepository } from "../../parser/index.ts";
import { OUTPUT_VERSION, type ParseResult } from "../../parser/types.ts";
import type { PipelineDb } from "./db.ts";
import { downloadArchive, parseRepoUrl, resolveCommit, RunError, type RepoRef } from "./github.ts";

export { RunError } from "./github.ts";

import type { Stage } from "./stages.ts";

export { STAGES, type Stage } from "./stages.ts";

/** Called as each stage begins, and with what it found as it ends. */
export type OnStage = (stage: Stage, message: string) => void;

/** Rows per insert. Large enough to be few round trips, small enough to stay under request limits. */
const CHUNK = 500;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

function failed(what: string, message: string): never {
  throw new Error(`Couldn't ${what}: ${message}`);
}

/**
 * The project for this repository in this organization, matched without
 * regard to case because GitHub names aren't case-sensitive.
 */
async function findProject(db: PipelineDb, orgId: string, ref: RepoRef) {
  // ilike with no wildcards is a case-insensitive equality; "_" is the only
  // wildcard a valid owner or name can contain, so it's escaped.
  const literal = (s: string) => s.replace(/_/g, "\\_");
  const { data, error } = await db
    .from("projects")
    .select("id, repo_owner, repo_name")
    .eq("org_id", orgId)
    .ilike("repo_owner", literal(ref.owner))
    .ilike("repo_name", literal(ref.name))
    .limit(1);
  if (error) failed("look up the repository", error.message);
  return data[0] ?? null;
}

/**
 * One analysis per repository. A repository this organization has already
 * analysed returns that analysis and starts nothing; re-running is a separate,
 * deliberate act. Otherwise a project and a queued analysis are created and
 * the caller runs it.
 *
 * Throws RunError, before creating anything, when the input isn't a GitHub
 * repository at all.
 */
export async function startAnalysis(
  db: PipelineDb,
  orgId: string,
  input: string,
): Promise<{ analysisId: string; existing: boolean }> {
  const ref = parseRepoUrl(input);

  // Organizations are Clerk's; this row only exists to be cascaded from.
  const org = await db.from("organizations").upsert({ id: orgId }, { onConflict: "id", ignoreDuplicates: true });
  if (org.error) failed("record the organization", org.error.message);

  let project = await findProject(db, orgId, ref);
  if (project) {
    const { data, error } = await db
      .from("analyses")
      .select("id")
      .eq("project_id", project.id)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) failed("look up the analysis", error.message);
    if (data[0]) return { analysisId: data[0].id, existing: true };
  } else {
    const inserted = await db
      .from("projects")
      .insert({ org_id: orgId, repo_owner: ref.owner, repo_name: ref.name })
      .select("id, repo_owner, repo_name")
      .single();
    // 23505: someone submitted the same repository a moment earlier.
    if (inserted.error?.code === "23505") project = await findProject(db, orgId, ref);
    else if (inserted.error) failed("record the repository", inserted.error.message);
    else project = inserted.data;
    if (!project) failed("record the repository", "it was created and then couldn't be found");
  }

  const { data, error } = await db
    .from("analyses")
    .insert({ org_id: orgId, project_id: project.id })
    .select("id")
    .single();
  // 23505: a simultaneous submission's analysis is already queued or running
  // (one active analysis per project is a unique index). Send this request to
  // that run rather than starting a second.
  if (error?.code === "23505") {
    const active = await db
      .from("analyses")
      .select("id")
      .eq("project_id", project.id)
      .eq("org_id", orgId)
      .in("status", ["queued", "running"])
      .limit(1);
    if (active.error) failed("look up the analysis", active.error.message);
    if (active.data[0]) return { analysisId: active.data[0].id, existing: true };
    failed("create the analysis", "another run was starting and then couldn't be found");
  }
  if (error) failed("create the analysis", error.message);
  return { analysisId: data.id, existing: false };
}

/**
 * Runs a queued analysis to completion or to a recorded failure. Never
 * throws for a failure of the run itself: that's written to the row. It
 * throws only if the row can't be found, or the failure can't be recorded.
 */
export async function runAnalysis(db: PipelineDb, analysisId: string, onStage: OnStage = () => {}): Promise<void> {
  const { data: analysis, error } = await db
    .from("analyses")
    .select("id, org_id, status, project:projects(repo_owner, repo_name)")
    .eq("id", analysisId)
    .single();
  if (error) failed("load the analysis", error.message);
  if (analysis.status !== "queued") {
    throw new Error(`Analysis ${analysisId} is ${analysis.status}; only a queued analysis can run.`);
  }
  if (!analysis.project) failed("load the analysis", "its repository is missing");

  const orgId = analysis.org_id;
  const ref: RepoRef = { owner: analysis.project.repo_owner, name: analysis.project.repo_name };
  let stage: Stage = "fetching";
  let dir: string | null = null;

  // Every report is a row update, and every row update is published by the
  // database to whoever is watching. The message is what the page shows.
  const report = async (next: Stage, message: string) => {
    stage = next;
    const { error } = await db
      .from("analyses")
      .update({ status: "running", stage: next, stage_message: message, progressed_at: new Date().toISOString() })
      .eq("id", analysisId)
      .eq("org_id", orgId);
    if (error) failed(`record the ${next} stage`, error.message);
    onStage(next, message);
  };

  try {
    await report("fetching", `Fetching github.com/${ref.owner}/${ref.name}`);
    const { sha, ref: canonical } = await resolveCommit(ref);
    const commit = await db.from("analyses").update({ commit_sha: sha }).eq("id", analysisId).eq("org_id", orgId);
    if (commit.error) failed("record the commit", commit.error.message);
    dir = await mkdtemp(join(tmpdir(), "atlas-"));
    const { links } = await downloadArchive(canonical, sha, dir);
    const skipped = await db.from("analyses").update({ links_skipped: links }).eq("id", analysisId).eq("org_id", orgId);
    if (skipped.error) failed("record skipped links", skipped.error.message);
    await report("fetching", `Fetched ${sha.slice(0, 7)}${links ? `, ${links} symbolic ${links === 1 ? "link" : "links"} left out` : ""}`);

    await report("selecting", "Listing the repository's files");
    const { paths } = listFiles(dir);
    if (paths.length === 0) throw new RunError("The repository has no files to read.");
    await report("selecting", `${paths.length} files`);

    await report("parsing", `Parsing ${paths.length} files`);
    const result = await parseRepository(dir);
    await report("parsing", `${result.coverage.filesParsed} parsed, ${result.coverage.filesSkipped} skipped, ${result.edges.length} connections`);

    await report("storing", `Storing ${result.files.length} files and ${result.edges.length} connections`);
    await store(db, orgId, analysisId, result);

    const done = await db
      .from("analyses")
      .update({
        status: "complete",
        stage: null,
        stage_message: `Mapped ${result.files.length} files and ${result.edges.length} connections`,
        progressed_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        coverage: result.coverage,
        adapter: result.adapter,
        parser_version: OUTPUT_VERSION,
      })
      .eq("id", analysisId)
      .eq("org_id", orgId);
    if (done.error) failed("mark the analysis complete", done.error.message);
    onStage("storing", `Mapped ${result.files.length} files and ${result.edges.length} connections`);
  } catch (e) {
    const message =
      e instanceof RunError
        ? e.message
        : `Something went wrong while ${stage}: ${e instanceof Error ? e.message : String(e)}`;
    // The stage stays as it was, so the row says where it stopped.
    const { error } = await db
      .from("analyses")
      .update({ status: "failed", error: message, progressed_at: new Date().toISOString(), finished_at: new Date().toISOString() })
      .eq("id", analysisId)
      .eq("org_id", orgId);
    if (error) throw new Error(`The run failed (${message}) and the failure couldn't be recorded: ${error.message}`);
    onStage(stage, `Failed: ${message}`);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Writes the parse result. Files first, since everything else points at them
 * by id. If any insert fails, everything this analysis wrote is removed so a
 * failed analysis never shows a partial map.
 */
async function store(db: PipelineDb, orgId: string, analysisId: string, result: ParseResult): Promise<void> {
  try {
    const ids = new Map<string, string>();
    for (const rows of chunks(result.files)) {
      const { data, error } = await db
        .from("files")
        .insert(
          rows.map((f) => ({
            org_id: orgId,
            analysis_id: analysisId,
            path: f.path,
            folder: f.folder,
            language: f.language,
            lines: f.lines,
            bytes: f.bytes,
            sha256: f.sha256,
            module: f.module,
            status: f.status,
            skip_reason: f.skipReason,
            had_syntax_errors: f.hadSyntaxErrors,
          })),
        )
        .select("id, path");
      if (error) failed("store files", error.message);
      for (const row of data) ids.set(row.path, row.id);
    }
    const id = (path: string) => ids.get(path) ?? failed("store connections", `no stored file for ${path}`);

    for (const rows of chunks(result.edges)) {
      const { error } = await db.from("edges").insert(
        rows.map((e) => ({
          org_id: orgId,
          analysis_id: analysisId,
          from_file_id: id(e.from),
          to_file_id: id(e.to),
          kind: e.kind,
        })),
      );
      if (error) failed("store connections", error.message);
    }

    const unresolved = result.imports.filter((i) => i.outcome !== "resolved");
    for (const rows of chunks(unresolved)) {
      const { error } = await db.from("imports").insert(
        rows.map((i) => ({
          org_id: orgId,
          analysis_id: analysisId,
          from_file_id: id(i.from),
          specifier: i.specifier,
          kind: i.kind,
          line: i.line,
          outcome: i.outcome,
          reason: i.reason ?? failed("store imports", `${i.from}:${i.line} has no reason`),
        })),
      );
      if (error) failed("store imports", error.message);
    }

    const roles = result.files.flatMap((f) => (f.role === null ? [] : [{ path: f.path, role: f.role }]));
    for (const rows of chunks(roles)) {
      const { error } = await db.from("file_roles").insert(
        rows.map((r) => ({ org_id: orgId, file_id: id(r.path), role: r.role, source: "convention" })),
      );
      if (error) failed("store file roles", error.message);
    }
  } catch (e) {
    // Files cascade to edges, imports and roles.
    const { error } = await db.from("files").delete().eq("analysis_id", analysisId).eq("org_id", orgId);
    if (error) throw new Error(`${e instanceof Error ? e.message : String(e)}; cleaning up also failed: ${error.message}`);
    throw e;
  }
}
