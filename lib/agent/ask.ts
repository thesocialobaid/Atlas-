// Asking the agent: open or continue a conversation on the agent service and
// turn its stream into the few events the chat shows: a lookup starting, a
// lookup finishing, the answer, the end. Plain server code, no Next, so a
// script can ask exactly the way the app does.
//
// The credential travels as run context, which the agent's tools read and its
// model never sees. Each conversation records which analysis it's about, so
// a conversation can't be continued against a different one.

/** Matches the agent's `name` in deep-agent/agent.ts. */
export const AGENT = "atlas-ask";

export type AskEvent =
  /** A lookup has started. `input` is what the agent asked for. */
  | { type: "step"; id: string; tool: string; input: Record<string, unknown> }
  /** That lookup came back. `ok` is false when it failed rather than answered. */
  | { type: "step-done"; id: string; ok: boolean }
  | { type: "answer"; text: string }
  | { type: "done"; thread: string }
  /** `thread` when the conversation exists and can be carried on despite this turn failing. */
  | { type: "error"; message: string; thread?: string };

export type Ask = {
  credential: string;
  analysisId: string;
  /** Who's asking, from their sign-in. The agent service keeps each person's conversations to them. */
  userId: string;
  /** Null starts a new conversation. */
  thread: string | null;
  question: string;
  /** What's selected on the map as the question is asked, if anything. */
  selected: Selected | null;
  signal?: AbortSignal;
};

export type Selected = { kind: "file" | "folder"; path: string };

/**
 * The message the agent reads: the selection on a line of its own, then the
 * question. It travels in the message rather than the run's context because
 * the model has to see it, and it's recorded in the conversation, so a
 * follow-up's "this file" still means the file selected when it was said.
 */
export function messageFor(question: string, selected: Selected | null): string {
  if (!selected) return question;
  const what = selected.kind === "file" ? `the file \`${selected.path}\`` : `the folder \`${selected.path}/\``;
  return `Selected on the map: ${what}\n\n${question}`;
}

/** Thrown before anything streams, for a caller to answer with a status. */
export class AskUnavailable extends Error {}

function agentEnv() {
  const url = process.env.AGENT_URL?.trim();
  const secret = process.env.AGENT_INGRESS_SECRET?.trim();
  if (!url || !secret) throw new AskUnavailable("The agent isn't configured: AGENT_URL and AGENT_INGRESS_SECRET must be set.");
  return { url, secret };
}

async function call(path: string, init: RequestInit & { userId: string }) {
  const { url, secret } = agentEnv();
  try {
    return await fetch(new URL(path, url), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-mda-ingress-secret": secret,
        "x-mda-user-id": init.userId,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new AskUnavailable("The agent isn't running, so questions can't be answered right now. Everything else still works.");
  }
}

/** The conversation to post to: the one asked for, if it's this person's and about this analysis, or a new one. */
async function conversation(ask: Ask): Promise<string> {
  if (ask.thread !== null) {
    const res = await call(`/threads/${encodeURIComponent(ask.thread)}`, { method: "GET", userId: ask.userId, signal: ask.signal });
    const body = res.ok ? ((await res.json()) as { metadata?: { analysis_id?: unknown } }) : null;
    if (!body || body.metadata?.analysis_id !== ask.analysisId) {
      throw new AskUnavailable("That conversation isn't available. Start a new one.");
    }
    return ask.thread;
  }
  const res = await call("/threads", {
    method: "POST",
    userId: ask.userId,
    signal: ask.signal,
    body: JSON.stringify({ metadata: { analysis_id: ask.analysisId } }),
  });
  if (!res.ok) throw new AskUnavailable(`The agent refused to start a conversation (${res.status}).`);
  return ((await res.json()) as { thread_id: string }).thread_id;
}

export type Message = {
  type: string;
  content: unknown;
  tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[];
  tool_call_id?: string;
  status?: string;
};

/** Messages arrive either plain or in LangChain's serialized form; this reads both. */
export function asMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (m.lc === 1 && m.kwargs && typeof m.kwargs === "object" && Array.isArray(m.id)) {
    const kind = String(m.id[m.id.length - 1]);
    const type = kind.startsWith("AIMessage") ? "ai" : kind.startsWith("ToolMessage") ? "tool" : kind.startsWith("HumanMessage") ? "human" : kind;
    return { ...(m.kwargs as Omit<Message, "type">), type };
  }
  return typeof m.type === "string" ? (m as unknown as Message) : null;
}

/** Gemini answers in parts; only the text parts are the answer. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/**
 * What went wrong, for the person asking. The provider's own message carries
 * request URLs and status codes; the one failure worth naming is the free
 * tier's per-minute limit, because waiting fixes it.
 */
function plainError(raw: string): string {
  if (/\b429\b|quota|rate.?limit|resource.?exhausted/i.test(raw)) {
    return "The model's free-tier limit for this minute was reached. Wait a minute and ask again.";
  }
  if (/\b503\b|overloaded|high demand/i.test(raw)) return "The model is overloaded right now. Ask again in a moment.";
  return "The agent failed while answering. Ask again; if it keeps failing, the agent's log says why.";
}

/** Our tools answer a failure with a sentence starting this way, rather than throwing. */
export const FAILED = "Lookup failed";

function* eventsFrom(update: unknown, seen: Set<string>): Generator<AskEvent> {
  if (!update || typeof update !== "object") return;
  for (const node of Object.values(update as Record<string, unknown>)) {
    const messages = node && typeof node === "object" ? (node as { messages?: unknown }).messages : undefined;
    if (!Array.isArray(messages)) continue;
    for (const raw of messages) {
      const m = asMessage(raw);
      if (!m) continue;
      if (m.type === "ai") {
        for (const call of m.tool_calls ?? []) {
          const id = call.id ?? `${call.name}:${seen.size}`;
          if (seen.has(id)) continue;
          seen.add(id);
          yield { type: "step", id, tool: call.name, input: call.args };
        }
        const text = textOf(m.content).trim();
        if (text && (m.tool_calls ?? []).length === 0) yield { type: "answer", text };
      } else if (m.type === "tool" && m.tool_call_id && !seen.has(`done:${m.tool_call_id}`)) {
        seen.add(`done:${m.tool_call_id}`);
        const ok = m.status !== "error" && !textOf(m.content).startsWith(FAILED);
        yield { type: "step-done", id: m.tool_call_id, ok };
      }
    }
  }
}

/**
 * Asks one question and yields what happens as it happens. Setup failures
 * (agent not running, conversation not this person's) throw AskUnavailable
 * before the first event; a failure mid-answer arrives as an error event.
 */
export async function* ask(question: Ask): AsyncGenerator<AskEvent> {
  const thread = await conversation(question);
  const res = await call(`/threads/${encodeURIComponent(thread)}/runs/stream`, {
    method: "POST",
    userId: question.userId,
    signal: question.signal,
    body: JSON.stringify({
      assistant_id: AGENT,
      input: { messages: [{ role: "user", content: messageFor(question.question, question.selected) }] },
      context: { credential: question.credential },
      stream_mode: ["updates"],
      on_disconnect: "cancel",
    }),
  });
  if (!res.ok || !res.body) throw new AskUnavailable(`The agent refused the question (${res.status}).`);

  const seen = new Set<string>();
  let answered = false;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    buffer += decoder.decode(read.value, { stream: true }).replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload: unknown = JSON.parse(data);
      if (event === "error") {
        const message = (payload as { message?: unknown })?.message;
        yield { type: "error", message: plainError(typeof message === "string" ? message : "") };
        return;
      }
      if (event === "updates") {
        for (const e of eventsFrom(payload, seen)) {
          if (e.type === "answer") answered = true;
          yield e;
        }
      }
    }
  }
  // A run can finish with nothing said: the model's last reply was empty.
  // That's reported, never shown as a finished turn with a blank answer.
  if (!answered) {
    yield { type: "error", message: "The agent finished without answering. Ask again.", thread };
    return;
  }
  yield { type: "done", thread };
}
