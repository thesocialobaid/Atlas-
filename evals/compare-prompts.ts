// node evals/compare-prompts.ts [--rebuild]
//
// The app's file-explanation prompt and the rewritten one in explain-prompt.ts,
// run over the same dataset as two experiments and scored the same way, then
// printed side by side. The dashboard's comparison view shows the same two.
//
// Two scores, and they aren't the same kind of number:
// - no_invented_paths is set membership, computed. It has an exact answer.
// - specific is a model's judgment of "is this specific enough to be
//   useful", which has no exact answer. The judge is the same model that
//   wrote both sets of explanations. Read it as one reader's opinion applied
//   consistently to both prompts: good for which is better, weak on how good.
//
// The dataset is built once from the stored analyses (files with the most
// connections in each repository, their source read at the analysed commit)
// and kept, so both prompts and every later run see the same files.

import "../lib/load-env.ts";
import type { Example, Run } from "langsmith/schemas";
import { evaluate } from "langsmith/evaluation";
import { chat, flushTraces, langsmith, MODEL } from "../lib/ai/client.ts";
import { ask, FILE_SYSTEM, fileMessage, shownInFile, type FileToExplain } from "../lib/ai/explain.ts";
import { checkPaths, INVENTED_PATHS_KEY } from "../lib/ai/invented.ts";
import { categoryOf } from "../lib/map/categories.ts";
import { REWRITTEN_FILE_SYSTEM } from "./explain-prompt.ts";
import { createFilledDataset, createPipelineDb, edgesOf, filesOf, firstLine, latestAnalyses, paced, requireTracing, strings, textAt } from "./data.ts";

const DATASET = "atlas: explanations";
const PER_REPO = 2;
const MAX_EXAMPLES = 24;

const PROMPTS = [
  { name: "app v1", prefix: "explain app-v1", system: FILE_SYSTEM },
  { name: "rewrite", prefix: "explain rewrite", system: REWRITTEN_FILE_SYSTEM },
] as const;

async function build(): Promise<void> {
  const db = createPipelineDb();
  const examples: { inputs: { file: FileToExplain; source: string }; metadata: { repo: string } }[] = [];
  const skipped: string[] = [];
  for (const a of await latestAnalyses(db)) {
    if (examples.length >= MAX_EXAMPLES) break;
    const [files, edges] = await Promise.all([filesOf(db, a.id), edgesOf(db, a.id)]);
    const pathOf = new Map(files.map((f) => [f.id, f.path]));
    const out = new Map<string, Set<string>>();
    const into = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));
    for (const e of edges) {
      const from = pathOf.get(e.from);
      const to = pathOf.get(e.to);
      if (!from || !to) throw new Error(`An edge in analysis ${a.id} points at a file that isn't stored.`);
      add(out, e.from, to);
      add(into, e.to, from);
    }
    // The files with the most connections: the ones an explanation has the most to say about.
    const degree = (id: string) => (out.get(id)?.size ?? 0) + (into.get(id)?.size ?? 0);
    const candidates = files
      .filter((f) => f.status === "parsed" && f.lines !== null && categoryOf(f) === "code" && degree(f.id) > 0)
      .sort((x, y) => degree(y.id) - degree(x.id) || (x.path < y.path ? -1 : 1));
    let taken = 0;
    for (const f of candidates) {
      if (taken >= PER_REPO || examples.length >= MAX_EXAMPLES) break;
      const got = await textAt(a, f);
      if ("skipped" in got) {
        skipped.push(`${a.repo.owner}/${a.repo.name} ${f.path}: ${got.skipped}`);
        continue;
      }
      taken++;
      const file: FileToExplain = {
        path: f.path,
        sha256: f.sha256,
        language: f.language,
        role: f.role?.role ?? null,
        imports: [...(out.get(f.id) ?? [])].sort(),
        importedBy: [...(into.get(f.id) ?? [])].sort(),
      };
      examples.push({ inputs: { file, source: got.text }, metadata: { repo: `${a.repo.owner}/${a.repo.name}` } });
    }
  }
  for (const s of skipped) console.log(`left out  ${s}`);
  if (examples.length === 0) throw new Error("No analysed file has a connection to explain. Analyse a repository first.");
  await createFilledDataset(
    DATASET,
    "Files from the stored analyses with their neighbours, as the app hands them to the explanation prompt, and their source at the analysed commit.",
    examples,
  );
  console.log(`dataset "${DATASET}": ${examples.length} files${skipped.length ? `, ${skipped.length} left out` : ""}`);
}

function asExample(inputs: Record<string, unknown>): { file: FileToExplain; source: string } {
  const { file, source } = inputs;
  const missing = new Error("An explanation example needs a file, with its path, hash, language and neighbours, and its source.");
  if (typeof source !== "string" || typeof file !== "object" || file === null) throw missing;
  if (!("path" in file && "sha256" in file && "language" in file && "imports" in file && "importedBy" in file)) throw missing;
  const { path, sha256, language, imports, importedBy } = file;
  if (typeof path !== "string" || typeof sha256 !== "string" || typeof language !== "string" || !strings(imports) || !strings(importedBy)) throw missing;
  const role = "role" in file && typeof file.role === "string" ? file.role : null;
  return { file: { path, sha256, language, role, imports, importedBy }, source };
}

function noInventedPaths({ run, example }: { run: Run; example: Example }) {
  const body = run.outputs?.body;
  if (run.error || typeof body !== "string") return { key: INVENTED_PATHS_KEY, comment: "No explanation to check." };
  const { mentioned, invented } = checkPaths(body, shownInFile(asExample(example.inputs).file));
  return {
    key: INVENTED_PATHS_KEY,
    score: invented.length === 0 ? 1 : 0,
    comment: invented.length ? `Not shown to the model: ${invented.join(", ")}` : `${mentioned.length} paths mentioned, all shown`,
  };
}

const JUDGE = `You judge one explanation of a source file, written for a developer who clicked the file on a map of a repository's dependencies.

You get what the writer was given (the file's path, its neighbours as a parser found them, and its source) and the explanation it wrote.

Decide one thing: is the explanation specific enough to be useful?
- Specific: it says what this particular file does in its repository, naming real functions, data or behaviour from the source, and what it does with the neighbours it names. A reader learns something they couldn't guess from the file's name and kind.
- Not specific: it would fit another file of the same kind with little change; it restates the path, the language or the import lists without saying what passes between them; or it's mostly generic statements.
Length is not specificity. Ignore formatting.

Reply with JSON only: {"reasoning": "<one or two sentences>", "specific": true or false}`;

async function specific({ run, example }: { run: Run; example: Example }) {
  const body = run.outputs?.body;
  if (run.error || typeof body !== "string") return { key: "specific", comment: "No explanation to judge." };
  const { file, source } = asExample(example.inputs);
  const res = await paced(() =>
    chat().chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: JUDGE },
        { role: "user", content: `What the writer was given:\n\n${fileMessage(file, source)}\n\n=== The explanation\n\n${body}` },
      ],
    }),
  );
  const text = res.choices[0]?.message.content ?? "";
  let verdict: unknown;
  try {
    verdict = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    verdict = null;
  }
  // An unreadable verdict is no score, not a failing one.
  if (typeof verdict !== "object" || verdict === null || !("specific" in verdict) || typeof verdict.specific !== "boolean") {
    return { key: "specific", comment: `The judge's reply wasn't a verdict: ${text.slice(0, 200)}` };
  }
  const reasoning = "reasoning" in verdict && typeof verdict.reasoning === "string" ? verdict.reasoning : "";
  return { key: "specific", score: verdict.specific ? 1 : 0, comment: reasoning };
}

type Scored = { name: string; experiment: string; invented: Map<string, number>; specific: Map<string, number>; failed: string[] };

async function runPrompt(p: (typeof PROMPTS)[number]): Promise<Scored> {
  const results = await evaluate(
    async (inputs: Record<string, unknown>) => {
      const { file, source } = asExample(inputs);
      return { body: await paced(() => ask(p.system, fileMessage(file, source))) };
    },
    {
      data: DATASET,
      evaluators: [noInventedPaths, specific],
      experimentPrefix: p.prefix,
      description: `File explanations under the ${p.name} prompt. no_invented_paths is computed; specific is ${MODEL} judging its own explanations.`,
      metadata: { prompt: p.name, model: MODEL, judge: MODEL },
      maxConcurrency: 2,
      client: langsmith(),
    },
  );
  const scored: Scored = { name: p.name, experiment: results.experimentName, invented: new Map(), specific: new Map(), failed: [] };
  for (const row of results.results) {
    if (row.run.error) {
      scored.failed.push(`${asExample(row.example.inputs).file.path}: ${firstLine(row.run.error)}`);
      continue;
    }
    for (const r of row.evaluationResults.results) {
      if (typeof r.score !== "number") continue;
      if (r.key === INVENTED_PATHS_KEY) scored.invented.set(row.example.id, r.score);
      if (r.key === "specific") scored.specific.set(row.example.id, r.score);
    }
  }
  return scored;
}

const pct = (m: Map<string, number>) => {
  if (m.size === 0) return "n/a";
  const pass = [...m.values()].filter((v) => v === 1).length;
  return `${((100 * pass) / m.size).toFixed(0)}% (${pass}/${m.size})`;
};

/** Examples both prompts were scored on, and which way each one went. */
function paired(a: Map<string, number>, b: Map<string, number>) {
  let bOnly = 0;
  let aOnly = 0;
  let both = 0;
  for (const [id, va] of a) {
    const vb = b.get(id);
    if (vb === undefined) continue;
    both++;
    if (vb > va) bOnly++;
    if (va > vb) aOnly++;
  }
  return { both, aOnly, bOnly };
}

async function main(argv: string[]) {
  requireTracing();
  const client = langsmith();
  if (argv.includes("--rebuild") && (await client.hasDataset({ datasetName: DATASET }))) {
    await client.deleteDataset({ datasetName: DATASET });
  }
  if (!(await client.hasDataset({ datasetName: DATASET }))) await build();

  const [a, b] = [await runPrompt(PROMPTS[0]), await runPrompt(PROMPTS[1])];
  await flushTraces();

  for (const s of [a, b]) for (const f of s.failed) console.log(`failed  ${s.name}  ${f}`);
  const row = (label: string, x: string, y: string, note: string) => console.log(`${label.padEnd(20)}${x.padEnd(16)}${y.padEnd(16)}${note}`);
  console.log("");
  row("", a.name, b.name, "");
  for (const [label, ma, mb] of [
    ["no invented paths", a.invented, b.invented],
    ["specific (judged)", a.specific, b.specific],
  ] as const) {
    const p = paired(ma, mb);
    const delta = p.both === 0 ? "" : `${b.name} better on ${p.bOnly}, worse on ${p.aOnly}, of ${p.both} scored for both`;
    row(label, pct(ma), pct(mb), delta);
  }
  console.log(`\n"specific" is ${MODEL} judging explanations it wrote: a consistent opinion, not a measurement.`);
  if (a.failed.length || b.failed.length) console.log("Some examples weren't explained (listed above); they're in neither score.");

  const dataset = await client.readDataset({ datasetName: DATASET });
  const sessions = await Promise.all([a, b].map((s) => client.readProject({ projectName: s.experiment })));
  const projectUrl = await client.getProjectUrl({ projectId: sessions[0].id });
  const org = projectUrl.slice(0, projectUrl.indexOf("/projects/"));
  console.log(`compare  ${org}/datasets/${dataset.id}/compare?selectedSessions=${sessions.map((s) => s.id).join(",")}`);
  if (a.failed.length || b.failed.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
