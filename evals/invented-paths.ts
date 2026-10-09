// node evals/invented-paths.ts [--days 30]
// node evals/invented-paths.ts --splice [path]
//
// The invented-path check over real explanations: every explanation traced in
// LangSmith in the last N days, cache hits included, each distinct answer
// scored once against the paths its trace says the model was shown. Prints
// the share with nothing invented and every flagged path, so each can be
// checked by hand against the trace.
//
// --splice takes the newest of those explanations, splices a made-up path into
// it, and shows the check catching it. Exits 1 if it doesn't.
//
// The app records the same check on every fresh explanation as it's written
// (feedback "no_invented_paths"); this reads the traces, not that feedback,
// so it covers answers written before the check existed.

import "../lib/load-env.ts";
import { langsmith } from "../lib/ai/client.ts";
import { shownInFile, shownInFolder, type FileToExplain } from "../lib/ai/explain.ts";
import { checkPaths } from "../lib/ai/invented.ts";
import { requireTracing, strings } from "./data.ts";

/** Runs read at most: enough for weeks of one person's use, and a bound on the read. */
const MAX_RUNS = 2000;

type Explanation = { runId: string; subject: string; body: string; shown: string[] };

const pairs = (v: unknown): v is { from: string; to: string }[] =>
  Array.isArray(v) &&
  v.every((x: unknown) => typeof x === "object" && x !== null && "from" in x && "to" in x && typeof x.from === "string" && typeof x.to === "string");

function asFile(v: Record<string, unknown>): FileToExplain | null {
  const { path, sha256, language, role, imports, importedBy } = v;
  if (typeof path !== "string" || typeof sha256 !== "string" || typeof language !== "string") return null;
  if (!(role === null || typeof role === "string") || !strings(imports) || !strings(importedBy)) return null;
  return { path, sha256, language, role, imports, importedBy };
}

/** A folder as its trace recorded it: only the parts that say which paths the model was shown. */
type TracedFolder = Parameters<typeof shownInFolder>[0] & { dir: string };

function asFolder(v: Record<string, unknown>): TracedFolder | null {
  const { dir, files, incoming, outgoing } = v;
  if (typeof dir !== "string" || !Array.isArray(files) || !pairs(incoming) || !pairs(outgoing)) return null;
  const paths: { path: string }[] = [];
  for (const entry of files) {
    const f: unknown = entry;
    if (typeof f !== "object" || f === null || !("path" in f) || typeof f.path !== "string") return null;
    paths.push({ path: f.path });
  }
  return { dir, files: paths, incoming, outgoing };
}

/** Recent explanations from the traces, newest first, one per distinct answer. */
async function recent(days: number): Promise<{ explanations: Explanation[]; runs: number; unreadable: number }> {
  const client = langsmith();
  const project = await client.readProject({ projectName: process.env.LANGSMITH_PROJECT ?? "default" });
  const seen = new Set<string>();
  const explanations: Explanation[] = [];
  let runs = 0;
  let unreadable = 0;
  const query = client.runs.query({
    project_ids: [project.id],
    is_root: true,
    has_error: false,
    filter: 'or(eq(name, "explain file"), eq(name, "explain folder"))',
    min_start_time: new Date(Date.now() - days * 86_400_000).toISOString(),
    selects: ["ID", "NAME", "INPUTS", "OUTPUTS"],
    page_size: 100,
  });
  for await (const run of query) {
    if (++runs > MAX_RUNS) break;
    const body = run.outputs?.body;
    const inputs = run.inputs ?? {};
    const file = run.name === "explain file" ? asFile(inputs) : null;
    const folder = run.name === "explain folder" ? asFolder(inputs) : null;
    if (!run.id || typeof body !== "string" || (!file && !folder)) {
      unreadable++;
      continue;
    }
    const shown = file ? shownInFile(file) : shownInFolder(folder!);
    const subject = file ? file.path : `${folder!.dir}/`;
    // A cache hit is the same answer to the same question: scored once.
    const key = JSON.stringify([subject, body]);
    if (seen.has(key)) continue;
    seen.add(key);
    explanations.push({ runId: run.id, subject, body, shown });
  }
  return { explanations, runs: Math.min(runs, MAX_RUNS), unreadable };
}

async function main(argv: string[]) {
  requireTracing();
  const daysAt = argv.indexOf("--days");
  const days = daysAt === -1 ? 30 : Number(argv[daysAt + 1]);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days takes a number of days.");

  const { explanations, runs, unreadable } = await recent(days);
  if (explanations.length === 0) throw new Error(`No explanations traced in the last ${days} days: explain a file in the app first.`);

  const spliceAt = argv.indexOf("--splice");
  if (spliceAt !== -1) return splice(explanations[0], argv[spliceAt + 1]);

  const client = langsmith();
  let clean = 0;
  for (const e of explanations) {
    const { mentioned, invented } = checkPaths(e.body, e.shown);
    if (invented.length === 0) {
      clean++;
      continue;
    }
    console.log(`\n${e.subject}  (${mentioned.length} paths mentioned, ${e.shown.length} shown)`);
    for (const p of invented) console.log(`  invented  ${p}`);
    console.log(`  trace     ${await client.getRunUrl({ runId: e.runId })}`);
  }
  console.log(
    `\n${clean} of ${explanations.length} explanations invented no path: ${((100 * clean) / explanations.length).toFixed(1)}%`,
  );
  console.log(`  from ${runs} traced runs in the last ${days} days; repeats of the same answer counted once`);
  if (unreadable) console.log(`  ${unreadable} runs not scored: their trace doesn't hold the inputs and answer in the expected shape`);
}

/** Splices a made-up path into a real explanation and runs the check on both. */
function splice(e: Explanation, given: string | undefined) {
  const dir = e.subject.includes("/") ? e.subject.slice(0, e.subject.lastIndexOf("/") + 1) : "";
  const madeUp = given ?? `${dir}session-cache.ts`;
  if (checkPaths(`\`${madeUp}\``, e.shown).invented.length === 0) {
    throw new Error(`${madeUp} was shown to the model for ${e.subject}, so it isn't made up. Pass another path.`);
  }
  const spliced = `${e.body}\n\nIt also hands its results to \`${madeUp}\`, which caches them between requests.`;
  const before = checkPaths(e.body, e.shown);
  const after = checkPaths(spliced, e.shown);
  console.log(`explanation of ${e.subject}, spliced with ${madeUp}\n`);
  console.log(`  as written: ${before.invented.length === 0 ? "nothing invented" : `invented ${before.invented.join(", ")}`}`);
  console.log(`  spliced:    ${after.invented.length === 0 ? "nothing invented" : `invented ${after.invented.join(", ")}`}`);
  const caught = after.invented.includes(madeUp);
  console.log(caught ? `\ncaught ${madeUp}` : `\nMISSED ${madeUp}`);
  if (!caught) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
