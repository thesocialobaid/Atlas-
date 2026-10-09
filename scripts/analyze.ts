// node scripts/analyze.ts <github url> --org <org_id>
//
// Runs the real pipeline from a terminal, before there's a form to start it
// from: the same start and run the app will call, against the real database.
// Prints each stage as it begins and what it found, then the stored counts.

import "../lib/load-env.ts";
import { createPipelineDb } from "../lib/pipeline/db.ts";
import { runAnalysis, startAnalysis } from "../lib/pipeline/run.ts";

async function main(argv: string[]) {
  const url = argv[0];
  const orgIndex = argv.indexOf("--org");
  const orgId = orgIndex === -1 ? undefined : argv[orgIndex + 1];
  if (!url || !orgId) throw new Error("usage: node scripts/analyze.ts <github url> --org <org_id>");

  const db = createPipelineDb();
  const started = Date.now();
  const { analysisId, existing } = await startAnalysis(db, orgId, url);
  if (existing) {
    console.log(`already analysed: ${analysisId}. Nothing was started.`);
    return;
  }
  console.log(`analysis ${analysisId}`);
  await runAnalysis(db, analysisId, (stage, message) => {
    console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${stage.padEnd(9)}  ${message}`);
  });

  const { data: row, error } = await db
    .from("analyses")
    .select("status, stage, error, commit_sha, links_skipped, coverage")
    .eq("id", analysisId)
    .single();
  if (error) throw new Error(error.message);
  const count = async (table: "files" | "edges" | "imports") => {
    const res = await db.from(table).select("id", { count: "exact", head: true }).eq("analysis_id", analysisId);
    if (res.error) throw new Error(res.error.message);
    return res.count ?? 0;
  };
  console.log(`\nstatus ${row.status}${row.status === "failed" ? ` in ${row.stage}: ${row.error}` : ""}`);
  console.log(`commit ${row.commit_sha ?? "none"}, symbolic links left out ${row.links_skipped ?? "n/a"}`);
  console.log(`stored: files ${await count("files")}, edges ${await count("edges")}, imports not resolved ${await count("imports")}`);
  if (row.status === "failed") process.exit(1);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
