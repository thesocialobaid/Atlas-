// node evals/agent-answers.ts [--days 30] [--project atlas-ask-local]
// node evals/agent-answers.ts --plant
//
// Whether the agent hedges instead of looking, and whether it talks about its
// own plumbing, over the questions people really asked: every answer traced
// in the agent's LangSmith project in the last N days. Prints how many were
// answered with nothing looked up, how many rest only on lookups that failed,
// and every flagged phrase next to its answer, so each one is read by hand.
//
// Scored from traces rather than by asking fresh questions: a script asking
// would need a credential, and minting one outside a signed-in member's
// session is exactly the key this system doesn't have.
//
// --plant takes the newest real answer, plants a hedge, a mention of a lookup
// and a question answered with nothing looked up, and shows each check
// catching its own. Exits 1 if any is missed, or if a clean answer is flagged.

import "../lib/load-env.ts";
import { langsmith } from "../lib/ai/client.ts";
import { AGENT } from "../lib/agent/ask.ts";
import { lastTurn, score, type AgentTurn, type Scored } from "../lib/agent/answer-checks.ts";
import { requireTracing } from "./data.ts";

/** Runs read at most: weeks of one person's questions, and a bound on the read. */
const MAX_RUNS = 2000;

/** Where `mda dev` traces the agent: its name, suffixed for a local server. */
const LOCAL_PROJECT = `${AGENT}-local`;

type Traced = { runId: string; turn: AgentTurn };

async function recent(projectName: string, days: number): Promise<{ turns: Traced[]; runs: number; unreadable: number }> {
  const client = langsmith();
  const project = await client.readProject({ projectName }).catch(() => {
    throw new Error(`No LangSmith project called "${projectName}". Is the agent running with LANGSMITH_TRACING=true in deep-agent/.env?`);
  });
  const turns: Traced[] = [];
  let runs = 0;
  let unreadable = 0;
  const query = client.runs.query({
    project_ids: [project.id],
    is_root: true,
    has_error: false,
    filter: `eq(name, "${AGENT}")`,
    min_start_time: new Date(Date.now() - days * 86_400_000).toISOString(),
    selects: ["ID", "OUTPUTS"],
    page_size: 100,
  });
  for await (const run of query) {
    if (++runs > MAX_RUNS) break;
    // The run's output is the whole conversation; its newest turn is this run's.
    const messages: unknown = run.outputs?.messages;
    const turn = Array.isArray(messages) ? lastTurn(messages) : null;
    if (!run.id || !turn) {
      unreadable++;
      continue;
    }
    turns.push({ runId: run.id, turn });
  }
  return { turns, runs: Math.min(runs, MAX_RUNS), unreadable };
}

const quote = (s: string, n = 160) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);

function report(projectName: string, days: number, turns: Traced[], runs: number, unreadable: number): void {
  const scored = turns.map((t) => ({ runId: t.runId, s: score(t.turn) }));
  const answered = scored.filter((x) => x.s.answer !== null);
  const unlooked = answered.filter((x) => !x.s.looked);
  const unbacked = answered.filter((x) => x.s.looked && !x.s.backed);
  const hedged = answered.filter((x) => x.s.hedged.length > 0);
  const plumbing = answered.filter((x) => x.s.plumbing.length > 0);
  const share = (n: number) => (answered.length === 0 ? "—" : `${((100 * n) / answered.length).toFixed(0)}%`);

  console.log(`${projectName}, last ${days} days: ${runs} runs read, ${answered.length} answers scored.`);
  if (unreadable > 0) console.log(`${unreadable} runs had no conversation to read and weren't scored.`);
  if (scored.length > answered.length) console.log(`${scored.length - answered.length} turns ended without an answer.`);
  console.log("");
  console.log(`Answered with nothing looked up   ${unlooked.length}  (${share(unlooked.length)})`);
  console.log(`Every lookup failed               ${unbacked.length}  (${share(unbacked.length)})`);
  console.log(`Hedged                            ${hedged.length}  (${share(hedged.length)})`);
  console.log(`Talked about its own plumbing     ${plumbing.length}  (${share(plumbing.length)})`);

  const list = (title: string, rows: { runId: string; s: Scored }[], why: (s: Scored) => string) => {
    if (rows.length === 0) return;
    console.log(`\n${title}`);
    for (const { runId, s } of rows) {
      console.log(`  ${runId}  ${quote(s.question, 80)}`);
      console.log(`    ${why(s)}`);
      console.log(`    ${quote(s.answer ?? "")}`);
    }
  };
  list("Answered with nothing looked up:", unlooked, () => "no lookups");
  // Not a failure by itself: "the analysis couldn't be read" is the right
  // answer then. Listed so an answer that claims more than that gets read.
  list("Every lookup failed (check the answer only says so):", unbacked, (s) => s.lookups.map((l) => l.tool).join(", "));
  list("Hedged:", hedged, (s) => s.hedged.join(", "));
  list("Plumbing:", plumbing, (s) => s.plumbing.join(", "));
}

/** Each check catches what's planted for it, and nothing in a clean answer. */
function plant(base: Traced | undefined): boolean {
  const clean: AgentTurn = base?.turn.answer
    ? base.turn
    : {
        question: "where is authentication handled?",
        lookups: [{ tool: "search_files", ok: true }],
        answer: "The analysis shows `lib/auth.ts`, imported by 4 files. Sign-in tokens are read in `app/api/auth/route.ts`.",
      };
  console.log(base?.turn.answer ? `Planting into run ${base.runId}.` : "No traced answers yet; planting into a fixed one.");

  const cases: { name: string; turn: AgentTurn; caught: (s: Scored) => boolean }[] = [
    { name: "a hedge", turn: { ...clean, answer: `${clean.answer} This is probably where sessions are checked.` }, caught: (s) => s.hedged.includes("probably") },
    { name: "a named lookup", turn: { ...clean, answer: `The search_files tool returned this. ${clean.answer}` }, caught: (s) => s.plumbing.includes("search_files") },
    { name: "a credential", turn: { ...clean, answer: "The analysis credential has expired, so nothing can be read." }, caught: (s) => s.plumbing.includes("analysis credential") },
    { name: "no lookup", turn: { ...clean, lookups: [] }, caught: (s) => !s.looked },
  ];

  let ok = true;
  const before = score(clean);
  // A real answer may already carry a flag; that's for the report to show. The
  // fixed one must be clean, or the checks are flagging ordinary repository talk.
  if (!base?.turn.answer && (before.hedged.length > 0 || before.plumbing.length > 0)) {
    console.log(`  FLAGGED a clean answer: ${[...before.hedged, ...before.plumbing].join(", ")}`);
    ok = false;
  }
  for (const c of cases) {
    const hit = c.caught(score(c.turn));
    console.log(`  ${hit ? "caught" : "MISSED"}  ${c.name}`);
    ok &&= hit;
  }
  const failSentence = score({ ...clean, answer: "The analysis couldn't be read just now and asking again may work." });
  if (failSentence.hedged.length > 0 || failSentence.plumbing.length > 0) {
    console.log("  FLAGGED the sentence the agent is told to say when a lookup fails.");
    ok = false;
  }
  return ok;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

requireTracing();
const projectName = arg("--project") ?? LOCAL_PROJECT;
const days = Number(arg("--days") ?? 30);
if (!Number.isFinite(days) || days <= 0) throw new Error("--days takes a positive number.");

const { turns, runs, unreadable } = await recent(projectName, days);
if (process.argv.includes("--plant")) {
  process.exit(plant(turns.find((t) => t.turn.answer !== null)) ? 0 : 1);
}
if (turns.length === 0) {
  console.error(`No answers traced in ${projectName} in the last ${days} days. Ask the agent something first.`);
  process.exit(1);
}
report(projectName, days, turns, runs, unreadable);
