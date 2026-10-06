"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createPipelineDb } from "@/lib/pipeline/db";
import { RunError, runAnalysis, startAnalysis } from "@/lib/pipeline/run";

export type AnalyseState = { error: string | null; input: string };

/**
 * The dashboard form. The organization comes from the session, never from the
 * form. A repository already analysed goes to its existing analysis; a new
 * one is created, the page moves to its progress straight away, and the run
 * happens after the response, where it writes its own progress.
 */
export async function analyseRepository(_prev: AnalyseState, form: FormData): Promise<AnalyseState> {
  const input = String(form.get("url") ?? "");
  const { orgId } = await auth();
  if (!orgId) return { error: "Choose an organization first: analyses belong to one.", input };

  const db = createPipelineDb();
  let started: { analysisId: string; existing: boolean };
  try {
    started = await startAnalysis(db, orgId, input);
  } catch (e) {
    if (e instanceof RunError) return { error: e.message, input };
    throw e;
  }

  if (!started.existing) {
    const id = started.analysisId;
    after(async () => {
      try {
        await runAnalysis(db, id);
      } catch (e) {
        // runAnalysis records every failure of the run itself; reaching here
        // means even that write failed, and the server log is all that's left.
        console.error(`Analysis ${id} could not record its outcome:`, e);
      }
    });
  }
  redirect(`/analyses/${started.analysisId}`);
}
