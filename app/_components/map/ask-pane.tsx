"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AskEvent, Selected } from "@/lib/agent/ask";
import type { Known } from "@/lib/map/prose";
import { Prose } from "./pane";

// Ask: questions about the whole repository, answered by the agent looking
// things up in this analysis. It replaces the right-hand pane rather than
// sitting in a tab beside Structure and Explanation, because those belong to
// a selection and this doesn't.

type Step = { id: string; tool: string; input: Record<string, unknown>; state: "running" | "done" | "failed" };

export type Turn = {
  question: string;
  selected: Selected | null;
  steps: Step[];
  answer: string | null;
  error: string | null;
  status: "asking" | "done" | "failed";
};

export type Conversation = {
  turns: Turn[];
  asking: boolean;
  send: (question: string, selected: Selected | null) => void;
  reset: () => void;
};

/**
 * The conversation, held by the workspace so stepping out of Ask and back in
 * finds it where it was. One question at a time: the agent answers a thread
 * in order, and a second question mid-answer would race the first.
 */
export function useConversation(analysisId: string): Conversation {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const thread = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const reset = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    thread.current = null;
    setTurns([]);
    setAsking(false);
  }, []);

  const send = useCallback(
    (question: string, selected: Selected | null) => {
      if (inFlight.current) return;
      const controller = new AbortController();
      inFlight.current = controller;
      setAsking(true);
      setTurns((prev) => [...prev, { question, selected, steps: [], answer: null, error: null, status: "asking" }]);

      // Every change lands on the newest turn: there's only ever one in flight.
      const update = (change: (t: Turn) => Turn) =>
        setTurns((prev) => (prev.length === 0 ? prev : [...prev.slice(0, -1), change(prev[prev.length - 1])]));
      const fail = (message: string) => update((t) => ({ ...t, error: message, status: "failed" }));

      const apply = (e: AskEvent) => {
        if (e.type === "step") {
          update((t) => ({ ...t, steps: [...t.steps, { id: e.id, tool: e.tool, input: e.input, state: "running" }] }));
        } else if (e.type === "step-done") {
          update((t) => ({
            ...t,
            steps: t.steps.map((s) => (s.id === e.id ? { ...s, state: e.ok ? "done" : "failed" } : s)),
          }));
        } else if (e.type === "answer") {
          update((t) => ({ ...t, answer: e.text }));
        } else if (e.type === "done") {
          thread.current = e.thread;
          update((t) => ({ ...t, status: "done" }));
        } else {
          if (e.thread) thread.current = e.thread;
          fail(e.message);
        }
      };

      void (async () => {
        try {
          const res = await fetch("/api/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ analysisId, thread: thread.current, question, selected }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
            return fail(typeof body?.error === "string" ? body.error : `The question couldn't be asked (${res.status}).`);
          }
          // One JSON event per line, applied as each line completes.
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          let ended = false;
          for (let read = await reader.read(); !read.done; read = await reader.read()) {
            buffer += read.value;
            let cut: number;
            while ((cut = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, cut).trim();
              buffer = buffer.slice(cut + 1);
              if (!line) continue;
              const event = JSON.parse(line) as AskEvent;
              if (event.type === "done" || event.type === "error") ended = true;
              apply(event);
            }
          }
          if (!ended) fail("The answer stopped before it finished. Ask again.");
        } catch {
          if (!controller.signal.aborted) fail("The answer stopped before it finished. Ask again.");
        } finally {
          if (inFlight.current === controller) {
            inFlight.current = null;
            setAsking(false);
          }
        }
      })();
    },
    [analysisId],
  );

  return { turns, asking, send, reset };
}

/** The button that switches the right-hand pane into Ask and back. */
export function AskToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      title={on ? "Back to the details" : "Ask about this repository"}
      className={`my-2 h-7 shrink-0 rounded-control border px-2 text-xs font-medium ${
        on ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      Ask
    </button>
  );
}

export function AskPane({
  name,
  conversation,
  selected,
  known,
  onGo,
  onGoFolder,
  onClose,
}: {
  name: string;
  conversation: Conversation;
  selected: Selected | null;
  known: Known;
  onGo: (path: string) => void;
  onGoFolder: (dir: string) => void;
  onClose: () => void;
}) {
  const { turns, asking, send, reset } = conversation;
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const sentAt = useRef<number | null>(null);

  // Scrolls once, to the question just sent, because sending was a click.
  // Steps and the answer arriving afterwards don't move anything.
  useEffect(() => {
    if (sentAt.current === null) return;
    const el = log.current?.querySelector(`[data-turn="${sentAt.current}"]`);
    el?.scrollIntoView({ block: "start" });
    sentAt.current = null;
  }, [turns.length]);

  const submit = () => {
    const question = draft.trim();
    if (!question || asking) return;
    sentAt.current = turns.length;
    send(question, selected);
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
        <h2 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs font-medium" title={name}>
          <span className="shrink-0">Ask</span>
          <span className="truncate font-mono font-normal text-fg-muted">{name}</span>
        </h2>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={reset}
            className="h-7 shrink-0 rounded-control px-2 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            New conversation
          </button>
        )}
        <AskToggle on onToggle={onClose} />
      </div>

      <div ref={log} className="min-h-0 flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <p className="px-3 py-3 text-xs leading-5 text-fg-muted">
            Answers are looked up in this analysis: where something lives, what imports what, what a change could
            reach, which routes and roles exist, and what was skipped. It doesn&apos;t judge the code.
          </p>
        ) : (
          turns.map((turn, i) => (
            <TurnView key={i} index={i} turn={turn} known={known} onGo={onGo} onGoFolder={onGoFolder} />
          ))
        )}
      </div>

      <form
        className="shrink-0 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {selected && (
          <p className="mb-1.5 truncate text-[11px] text-fg-muted" title={selected.path}>
            With <span className="font-mono text-fg">{selected.kind === "folder" ? `${selected.path}/` : selected.path}</span>{" "}
            selected
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder="Where is authentication handled?"
            aria-label="Question"
            className="min-h-0 flex-1 resize-none rounded-control border border-border bg-bg px-2 py-1.5 text-xs leading-4 placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={asking || draft.trim() === ""}
            className="h-7 shrink-0 rounded-control bg-accent px-2.5 text-xs font-medium text-on-accent disabled:bg-surface-2 disabled:text-fg-muted"
          >
            {asking ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TurnView({
  index,
  turn,
  known,
  onGo,
  onGoFolder,
}: {
  index: number;
  turn: Turn;
  known: Known;
  onGo: (path: string) => void;
  onGoFolder: (dir: string) => void;
}) {
  return (
    <section data-turn={index} className="border-b border-border px-3 py-3 text-xs">
      <p className="leading-5 font-medium whitespace-pre-wrap">{turn.question}</p>
      {turn.selected && (
        <p className="truncate font-mono text-[11px] text-fg-muted" title={turn.selected.path}>
          {turn.selected.kind === "folder" ? `${turn.selected.path}/` : turn.selected.path}
        </p>
      )}

      {turn.steps.length > 0 && (
        <ol aria-label="Lookups" className="mt-2 space-y-0.5 border-l border-border pl-2">
          {turn.steps.map((step) => (
            <li key={step.id} className="flex items-baseline gap-2 text-[11px] leading-4">
              <span className="min-w-0 flex-1 text-fg-muted">
                <StepLabel step={step} />
              </span>
              <span className={`shrink-0 ${step.state === "failed" ? "text-danger" : "text-fg-muted"}`}>
                {step.state === "running" ? "looking…" : step.state === "failed" ? "failed" : "done"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {turn.status === "asking" && turn.steps.length === 0 && <p className="mt-2 text-fg-muted">Starting…</p>}

      {turn.answer !== null && (
        <>
          <Prose text={turn.answer} known={known} onGo={onGo} onGoFolder={onGoFolder} />
          {/* The middleware makes a lookup come first, so this shouldn't
              happen. If it ever does, the answer says so rather than passing
              for one that was checked. */}
          {turn.steps.length === 0 && (
            <p className="mt-2 text-[11px] leading-4 text-danger">
              Nothing was looked up for this answer, so it isn&apos;t backed by the analysis.
            </p>
          )}
        </>
      )}
      {turn.error && (
        <p role="alert" className="mt-2 leading-5 text-danger">
          {turn.error}
        </p>
      )}
    </section>
  );
}

/** What a lookup asked for, in words, with any path in monospace. */
function StepLabel({ step }: { step: Step }) {
  const text = (key: string) => (typeof step.input[key] === "string" ? (step.input[key] as string) : "");
  const mono = (v: string) => <span className="font-mono break-all text-fg">{v}</span>;
  switch (step.tool) {
    case "analysis_summary":
      return <>Read the analysis summary</>;
    case "search_files":
      return <>Searched paths for {mono(`"${text("text")}"`)}</>;
    case "files_by_role":
      return <>Listed files with the role {mono(text("role"))}</>;
    case "file_neighbours":
      return <>Read the direct imports of {mono(text("path"))}</>;
    case "walk_imports":
      return text("direction") === "dependencies" ? (
        <>Walked what {mono(text("path"))} needs</>
      ) : (
        <>Walked what imports {mono(text("path"))}</>
      );
    case "list_routes":
      return <>Read the route table</>;
    default:
      return mono(step.tool);
  }
}
