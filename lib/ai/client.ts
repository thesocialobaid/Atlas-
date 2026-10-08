// The one place that constructs the AI client. Everything the model is asked
// goes through `chat` below, which is the wrapped client, so every call is
// traced. A second `new OpenAI()` anywhere else would silently skip tracing,
// so ESLint refuses an import of "openai" outside this file.
//
// Plain server code: no Next, no React, runnable from a script.

import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import { wrapOpenAI } from "langsmith/wrappers";
import OpenAI from "openai";

/**
 * Pinned to an exact version, never an alias like "-latest": the model name is
 * part of every cache key, so a moving alias would serve answers from one
 * model as if another wrote them. Re-pinning misses only this model's entries.
 */
export const MODEL = "gemini-3.5-flash-lite";

// Gemini, reached through its OpenAI-compatible endpoint, so the client is the
// OpenAI SDK and LangSmith's OpenAI wrapper records each call with its tokens.
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Why the model can't be asked, written for the person who clicked. */
export class AiUnavailable extends Error {}

/**
 * Whether calls are being traced, and if not, why. Calls succeed either way;
 * this exists so an unconfigured setup can say so instead of looking exactly
 * like a working one with no traffic.
 */
export function tracingStatus(): { on: true } | { on: false; reason: string } {
  if (process.env.LANGSMITH_TRACING?.trim() !== "true") return { on: false, reason: "LANGSMITH_TRACING isn't set to true" };
  if (!process.env.LANGSMITH_API_KEY?.trim()) return { on: false, reason: "LANGSMITH_API_KEY isn't set" };
  return { on: true };
}

// One LangSmith client, shared by the wrapper and every traced step, so a
// script can wait for its traces to be sent before it exits. It needs no key
// to exist; with tracing off it sends nothing.
const traces = new Client();

let wrapped: OpenAI | null = null;

/** The wrapped client. Throws AiUnavailable when there's no key. */
export function chat(): OpenAI {
  if (wrapped) return wrapped;
  const key = process.env.GOOGLE_API_KEY?.trim();
  if (!key) throw new AiUnavailable("GOOGLE_API_KEY isn't set, so the model can't be asked.");
  wrapped = wrapOpenAI(new OpenAI({ apiKey: key, baseURL: BASE_URL, maxRetries: 3, timeout: 60_000 }), {
    client: traces,
    tracingEnabled: tracingStatus().on,
  });
  return wrapped;
}

/**
 * A traced step: the given function, recorded as a run under whatever traced
 * call is in progress. Every model-facing operation is one of these, with its
 * cache read inside it, so a cache hit is a recorded run with no model call.
 */
export function traced<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
  runType: "chain" | "retriever" | "tool" = "chain",
) {
  return traceable(fn, {
    name,
    run_type: runType,
    tracingEnabled: tracingStatus().on,
    metadata: { model: MODEL },
    client: traces,
  });
}

/** Waits for traces already recorded to reach LangSmith. Scripts call it before exiting. */
export async function flushTraces(): Promise<void> {
  if (tracingStatus().on) await traces.awaitPendingTraceBatches();
}
