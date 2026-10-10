// The two ways an agent answer goes wrong that the product can't afford:
// hedging instead of looking (answering from what projects like this usually
// contain), and talking about its own plumbing (tools, lookups, credentials).
// Pure, over one turn of a conversation, so the eval and anything else score
// an answer the same way.
//
// Both are phrase checks, and phrase checks over prose are approximate in both
// directions. So they never decide anything on their own: they flag, and the
// eval prints every flagged phrase next to its answer to be read by hand.

import { asMessage, FAILED, textOf } from "./ask.ts";

/** One question and what the agent did about it. */
export type AgentTurn = {
  question: string;
  /** Each lookup made for this question, in order, with whether it answered. */
  lookups: { tool: string; ok: boolean }[];
  /** The final text, or null when the turn ended without one. */
  answer: string | null;
};

/**
 * The newest turn in a conversation's messages: the last question and
 * everything after it. Null when there's no question to anchor on.
 */
export function lastTurn(raw: readonly unknown[]): AgentTurn | null {
  const messages = raw.map(asMessage);
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === "human") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const question = textOf(messages[start]!.content);
  const results = new Map<string, boolean>();
  for (const m of messages.slice(start + 1)) {
    if (m?.type === "tool" && m.tool_call_id) {
      results.set(m.tool_call_id, m.status !== "error" && !textOf(m.content).startsWith(FAILED));
    }
  }
  const lookups: AgentTurn["lookups"] = [];
  let answer: string | null = null;
  for (const m of messages.slice(start + 1)) {
    if (m?.type !== "ai") continue;
    for (const call of m.tool_calls ?? []) lookups.push({ tool: call.name, ok: call.id ? (results.get(call.id) ?? false) : false });
    const text = textOf(m.content).trim();
    if (text && (m.tool_calls ?? []).length === 0) answer = text;
  }
  return { question, lookups, answer };
}

/**
 * Prose with the repository's own words removed: code spans and anything
 * path-shaped. A file called `tools/lookup.ts` or a route at `/api/token` is
 * the repository talking, not the agent.
 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\S+\.[a-z]{1,5}\b/gi, " ");
}

function found(text: string, patterns: readonly RegExp[]): string[] {
  const body = prose(text);
  const hits = new Set<string>();
  for (const p of patterns) for (const m of body.matchAll(new RegExp(p.source, "gi"))) hits.add(m[0].toLowerCase());
  return [...hits];
}

// Words that mean "what I'd expect" rather than "what the analysis shows".
// "May" alone is left out: "asking again may work" is the sentence the agent
// is told to say when a lookup fails.
const HEDGES: readonly RegExp[] = [
  /\bprobably\b/,
  /\blikely\b/,
  /\bpresumably\b/,
  /\btypically\b/,
  /\busually\b/,
  /\bgenerally\b/,
  /\bcommonly\b/,
  /\bmight\b/,
  /\bmay (?:be|have|contain|handle|use)\b/,
  /\bit (?:seems|appears)\b/,
  /\bappears to\b/,
  /\bI (?:think|believe|assume|suspect|guess)\b/,
  /\bI(?:'m| am) not (?:sure|certain)\b/,
  /\bmost (?:projects|codebases|apps|applications|repositories)\b/,
  /\bin (?:a|many) (?:typical|standard) (?:project|codebase|setup)\b/,
];

// The agent's own machinery. Instructions forbid naming any of it.
const PLUMBING: readonly RegExp[] = [
  /\banalysis_summary\b/,
  /\bsearch_files\b/,
  /\bfiles_by_role\b/,
  /\bfile_neighbours\b/,
  /\bwalk_imports\b/,
  /\blist_routes\b/,
  /\btools?\b/,
  /\blook-?ups?\b/,
  /\bfunction calls?\b/,
  // Credentials and tokens are also what auth code is made of, so only the
  // agent's own count: the one the analysis was opened with.
  /\b(?:analysis|access|my|the agent's) (?:credentials?|tokens?)\b/,
  /\b(?:credential|token) (?:has )?(?:expired|is (?:no longer )?valid|is invalid)\b/,
  /\bJSON\b/,
  /\bstatus code\b/,
  /\b(?:401|403|404|500|503)\b/,
  /\bsystem prompt\b/,
  /\b(?:my|these|the) instructions\b/,
  /\bI(?:'m| am) (?:an? )?(?:AI|agent|language model|assistant)\b/,
];

export const hedges = (answer: string) => found(answer, HEDGES);
export const plumbing = (answer: string) => found(answer, PLUMBING);

export type Scored = AgentTurn & {
  /** At least one lookup was made for this question. */
  looked: boolean;
  /** At least one came back with an answer. A failed one is honest to report, but backs nothing said. */
  backed: boolean;
  hedged: string[];
  plumbing: string[];
};

export function score(turn: AgentTurn): Scored {
  const text = turn.answer ?? "";
  return {
    ...turn,
    looked: turn.lookups.length > 0,
    backed: turn.lookups.some((l) => l.ok),
    hedged: hedges(text),
    plumbing: plumbing(text),
  };
}
