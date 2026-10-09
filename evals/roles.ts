// node evals/roles.ts [--rebuild]
//
// Role accuracy. Files a convention already gave a role never reach the
// labeller in normal operation, so they're a held-out set with real ground
// truth: show the model a file without its role, ask through the pipeline's
// own prompt, compare. Prints the percentage; the experiment is in LangSmith.
//
// The dataset is built from the stored analyses the first time, and kept so
// every run scores the same files. --rebuild makes it again from what's
// stored now.

import "../lib/load-env.ts";
import type { Example, Run } from "langsmith/schemas";
import { evaluate } from "langsmith/evaluation";
import { flushTraces, langsmith, MODEL } from "../lib/ai/client.ts";
import { askRoles, LABEL_HEAD_LINES } from "../lib/ai/label.ts";
import { LABEL, LABEL_FRAMEWORK } from "../parser/adapters/taxonomy.ts";
import { createPipelineDb, filesOf, firstLine, latestAnalyses, paced, requireTracing, textAt } from "./data.ts";

const DATASET = "atlas: conventional roles";

/** At most this many files per repository and role, so one big repository's components don't make up the set. */
const PER_REPO_ROLE = 6;

/** Fewer than this and a percentage says more about which files were picked than about the model. */
const MIN_EXAMPLES = 30;

/**
 * A role spelled like one the labeller may answer but meaning something else.
 * A file here would be scored against a question the labeller isn't asked.
 */
const DIFFERENT_MEANING: Record<string, string> = {
  "sveltekit:hook": "SvelteKit's hooks file handles requests on the server; the labeller's hook is a UI hook",
};

const allowed = new Set<string>(LABEL.map((r) => r.role));

async function build(): Promise<void> {
  const db = createPipelineDb();
  const examples: { inputs: { path: string; head: string }; outputs: { role: string }; metadata: { repo: string; framework: string } }[] = [];
  const skipped: string[] = [];
  for (const a of await latestAnalyses(db)) {
    const taken = new Map<string, number>();
    for (const f of await filesOf(db, a.id)) {
      const r = f.role;
      // Only what convention decided, and only roles the labeller is allowed to give.
      if (!r || r.source !== "convention" || r.framework === LABEL_FRAMEWORK || !allowed.has(r.role)) continue;
      if (DIFFERENT_MEANING[`${r.framework}:${r.role}`]) continue;
      if ((taken.get(r.role) ?? 0) >= PER_REPO_ROLE) continue;
      const got = await textAt(a, f);
      if ("skipped" in got) {
        skipped.push(`${a.repo.owner}/${a.repo.name} ${f.path}: ${got.skipped}`);
        continue;
      }
      taken.set(r.role, (taken.get(r.role) ?? 0) + 1);
      examples.push({
        // The same head the pipeline shows the labeller.
        inputs: { path: f.path, head: got.text.split("\n").slice(0, LABEL_HEAD_LINES).join("\n") },
        outputs: { role: r.role },
        metadata: { repo: `${a.repo.owner}/${a.repo.name}`, framework: r.framework },
      });
    }
  }
  for (const s of skipped) console.log(`left out  ${s}`);
  if (examples.length < MIN_EXAMPLES) {
    throw new Error(`Only ${examples.length} files have a conventional role the labeller may give; at least ${MIN_EXAMPLES} are needed. Analyse more repositories.`);
  }
  const client = langsmith();
  const dataset = await client.createDataset(DATASET, {
    description: "Files whose role a convention assigned, limited to roles the labeller is allowed to answer. Inputs are what the labeller sees; the output is the conventional role.",
  });
  await client.createExamples(examples.map((e) => ({ ...e, dataset_id: dataset.id })));
  console.log(`dataset "${DATASET}": ${examples.length} files${skipped.length ? `, ${skipped.length} left out` : ""}`);
}

function isFile(v: Record<string, unknown>): v is { path: string; head: string } {
  return typeof v.path === "string" && typeof v.head === "string";
}

/** One file per question, so each example's trace holds the exact call made for it. */
async function label(inputs: Record<string, unknown>): Promise<{ role: string | null }> {
  if (!isFile(inputs)) throw new Error("A role example needs a path and a head.");
  const file = inputs;
  const answers = await paced(() => askRoles([file]));
  return { role: answers.get(inputs.path) ?? null };
}

// A run that errored has no answer to score: it's left unscored, so it's
// counted as a failure below and not as a wrong role.
function roleCorrect({ run, example }: { run: Run; example: Example }) {
  if (run.error) return { key: "role_correct", comment: `No answer: ${firstLine(run.error)}` };
  const expected = example.outputs?.role;
  const answered = run.outputs?.role ?? "nothing";
  return { key: "role_correct", score: answered === expected ? 1 : 0, comment: `Answered ${answered}; convention says ${expected}` };
}

async function main(argv: string[]) {
  requireTracing();
  const client = langsmith();
  if (argv.includes("--rebuild") && (await client.hasDataset({ datasetName: DATASET }))) {
    await client.deleteDataset({ datasetName: DATASET });
  }
  if (!(await client.hasDataset({ datasetName: DATASET }))) await build();

  const results = await evaluate(label, {
    data: DATASET,
    evaluators: [roleCorrect],
    experimentPrefix: "roles",
    description: `The pipeline's labelling prompt on files convention already labelled, role hidden. Model ${MODEL}.`,
    metadata: { model: MODEL },
    // Calls are paced one at a time anyway; this only keeps scoring alongside.
    maxConcurrency: 2,
    client,
  });

  let right = 0;
  let wrong = 0;
  let none = 0;
  const failures: string[] = [];
  const misses: string[] = [];
  for (const row of results.results) {
    const path = String(row.example.inputs.path);
    if (row.run.error) {
      failures.push(`${path}: ${firstLine(row.run.error)}`);
      continue;
    }
    const answered = row.run.outputs?.role ?? null;
    if (answered === row.example.outputs?.role) right++;
    else {
      wrong++;
      if (answered === null || answered === "none") none++;
      misses.push(`${path}  convention ${row.example.outputs?.role}, model ${answered ?? "nothing"}`);
    }
  }
  await flushTraces();

  for (const m of misses) console.log(`miss  ${m}`);
  for (const f of failures) console.log(`failed  ${f}`);
  const scored = right + wrong;
  console.log(`\nrole accuracy ${scored === 0 ? "n/a" : `${((100 * right) / scored).toFixed(1)}%`}: ${right} of ${scored} files right`);
  console.log(`  of the ${wrong} wrong, ${none} answered "none" rather than a different role`);
  if (failures.length) console.log(`  ${failures.length} not scored: the model couldn't be asked (listed above)`);
  console.log(`experiment ${results.experimentName}`);
  if (failures.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
