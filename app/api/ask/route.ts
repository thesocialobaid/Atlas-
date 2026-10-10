// Ask a question about one analysis. The signed-in member proves they can see
// it by asking the database for a credential, which only comes back for an
// analysis in their active organization. That credential goes to the agent
// and never to the browser, and the answer streams back as it's worked out.
//
// Response: one JSON event per line (see AskEvent), so each lookup shows the
// moment it starts rather than after the whole answer.

import { auth } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { ask, AskUnavailable, type AskEvent, type Selected } from "@/lib/agent/ask";
import { mintAgentCredential } from "@/lib/analyses";

/** Longer than this and it isn't a question about a map. */
const MAX_QUESTION = 2000;

/** Longer than any path in a repository we'd parse. */
const MAX_PATH = 500;

type Body = { analysisId?: unknown; thread?: unknown; question?: unknown; selected?: unknown };

/**
 * The map's selection, if it's shaped like one. It's only ever a path the
 * member clicked on their own map; the agent still looks it up before saying
 * anything about it, so a path that isn't in the analysis is just not found.
 */
function selectedFrom(raw: unknown): Selected | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, path } = raw as { kind?: unknown; path?: unknown };
  if ((kind !== "file" && kind !== "folder") || typeof path !== "string") return null;
  if (!path || path.length > MAX_PATH || /[\r\n`]/.test(path)) return null;
  return { kind, path };
}

function refuse(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return refuse(401, "Sign in to ask.");

  const body = (await req.json().catch(() => null)) as Body | null;
  const analysisId = typeof body?.analysisId === "string" ? body.analysisId : "";
  const thread = typeof body?.thread === "string" && body.thread ? body.thread : null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return refuse(400, "Ask a question.");
  if (question.length > MAX_QUESTION) return refuse(400, `Questions are limited to ${MAX_QUESTION} characters.`);

  const credential = await mintAgentCredential(analysisId);
  if (!credential) return refuse(404, "No finished analysis with that id in this organization.");

  // Pull the first event before answering, so a setup failure (agent not
  // running, someone else's conversation) is a status, not a broken stream.
  const selected = selectedFrom(body?.selected);
  const events = ask({ credential, analysisId, userId, thread, question, selected, signal: req.signal });
  let first: IteratorResult<AskEvent>;
  try {
    first = await events.next();
  } catch (error) {
    if (error instanceof AskUnavailable) return refuse(503, error.message);
    throw error;
  }

  const encoder = new TextEncoder();
  const line = (event: AskEvent) => encoder.encode(`${JSON.stringify(event)}\n`);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(line(first.value));
        for await (const event of events) controller.enqueue(line(event));
      } catch (error) {
        if (!req.signal.aborted) {
          const message = error instanceof AskUnavailable ? error.message : "The agent stopped answering.";
          controller.enqueue(line({ type: "error", message }));
        }
      } finally {
        controller.close();
      }
    },
    cancel() {
      void events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
