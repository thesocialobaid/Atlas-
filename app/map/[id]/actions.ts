"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AiUnavailable, MODEL, tracingStatus } from "@/lib/ai/client";
import { explainFile, explainFolder } from "@/lib/ai/explain";
import { getAnalysis, getFileStamp, getFileToExplain, getFolderToExplain } from "@/lib/analyses";
import { checkFreshness, type Freshness } from "@/lib/freshness";
import { createPipelineDb } from "@/lib/pipeline/db";
import { readFileAt, RunError } from "@/lib/pipeline/github";
import { runAnalysis, startReanalysis } from "@/lib/pipeline/run";
import { createSupabase } from "@/lib/supabase";

export type ExplainResult =
  | {
      ok: true;
      body: string;
      cached: boolean;
      model: string;
      /** Null when traced; otherwise why not, so an unconfigured setup says so. */
      untraced: string | null;
    }
  | { ok: false; message: string };

function untraced(): string | null {
  const t = tracingStatus();
  return t.on ? null : t.reason;
}

function failure(e: unknown): ExplainResult {
  if (e instanceof AiUnavailable || e instanceof RunError) return { ok: false, message: e.message };
  console.error("Explaining failed:", e);
  return { ok: false, message: `The model couldn't be asked: ${e instanceof Error ? e.message : String(e)}` };
}

/**
 * Explains one file. Its neighbours come from the stored edges; its source is
 * read from GitHub at the analysed commit and must hash to what was stored,
 * so the model reads exactly the file the map was drawn from.
 */
export async function explainFileAction(analysisId: string, path: string): Promise<ExplainResult> {
  const { orgId } = await auth();
  if (!orgId) return { ok: false, message: "Choose an organization first." };
  const loaded = await getFileToExplain(analysisId, path);
  if (!loaded) return { ok: false, message: "That file isn't in this analysis." };
  if (loaded.binary) return { ok: false, message: "This is a binary file: there's no source to explain." };

  const readSource = async () => {
    const got = await readFileAt(loaded.repo, loaded.commit, path);
    if (!got) throw new RunError(`${path} isn't on GitHub at the analysed commit any more.`);
    if (got.sha256 !== loaded.explain.sha256) {
      throw new RunError(`${path} on GitHub doesn't match the file that was analysed, so it isn't explained.`);
    }
    return got.text;
  };
  try {
    // The member's own client: the cache is read and written under their
    // organization's policy, never with the pipeline's secret key.
    const { body, cached } = await explainFile(createSupabase(), orgId, loaded.explain, readSource);
    return { ok: true, body, cached, model: MODEL, untraced: untraced() };
  } catch (e) {
    return failure(e);
  }
}

/** Explains a folded folder: what's in it, and why what points at it does. */
export async function explainFolderAction(analysisId: string, dir: string): Promise<ExplainResult> {
  const { orgId } = await auth();
  if (!orgId) return { ok: false, message: "Choose an organization first." };
  const folder = await getFolderToExplain(analysisId, dir);
  if (!folder) return { ok: false, message: "That folder isn't drawn in this analysis." };
  try {
    const { body, cached } = await explainFolder(createSupabase(), orgId, folder);
    return { ok: true, body, cached, model: MODEL, untraced: untraced() };
  } catch (e) {
    return failure(e);
  }
}

/** Whether an explained file still matches the repository on GitHub. */
export async function freshnessAction(analysisId: string, path: string): Promise<Freshness> {
  // Only the stored hash and the commit are needed, not the neighbours.
  const stamp = await getFileStamp(analysisId, path);
  if (!stamp) return { state: "unknown", reason: "that file isn't in this analysis" };
  return checkFreshness(stamp.repo, stamp.commit, path, stamp.file.sha256);
}

/**
 * Re-analyses the repository this analysis is of, then goes to the new run's
 * progress. The organization comes from the session; the analysis is read
 * through the policy first, so another organization's id finds nothing.
 */
export async function reanalyseAction(analysisId: string): Promise<{ error: string }> {
  const { orgId } = await auth();
  if (!orgId) return { error: "Choose an organization first." };
  const analysis = await getAnalysis(analysisId);
  if (!analysis) return { error: "That analysis isn't readable here." };

  const db = createPipelineDb();
  const started = await startReanalysis(db, orgId, analysis.project_id);
  if (!started.existing) {
    const id = started.analysisId;
    after(async () => {
      try {
        await runAnalysis(db, id);
      } catch (e) {
        console.error(`Analysis ${id} could not record its outcome:`, e);
      }
    });
  }
  redirect(`/analyses/${started.analysisId}`);
}
