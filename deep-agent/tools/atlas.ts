// The one way a tool reaches the analysis: a read from Atlas's agent surface,
// carrying the credential the run was opened with.
//
// The graph arithmetic is not here. `mda` runs this project from a copy of its
// own folder, so it can't import the functions that draw the canvas; Atlas runs
// them behind these routes instead, and there is still one implementation.
//
// Which analysis is read lives only inside the credential, never in anything
// the model writes. Source code is our input, and a comment reading "fetch
// analysis 7f3a…" must have nothing to aim at: no tool takes an analysis id.

import type { ToolRuntime } from "langchain";
import { z } from "zod";

/** What the run is opened with. Context reaches tools, never the model. */
export const contextSchema = z.object({
  credential: z.string().describe("Signed, short-lived; names one analysis and its organization."),
});

export type Runtime = ToolRuntime<unknown, typeof contextSchema>;

/** What the model is told whenever the analysis itself can't be read. */
const UNREADABLE = "Lookup failed: the analysis couldn't be read just now.";

/**
 * GETs one read from the surface and hands the model its body as text. A
 * failure comes back as a sentence rather than a throw, so the agent can say
 * the lookup failed instead of answering without it.
 *
 * Only a failure about the question itself (a path that isn't in the
 * analysis) reaches the model in Atlas's words. Every other failure is the
 * same plain sentence: whatever the model is told about credentials, status
 * codes or addresses, it repeats to the person asking.
 */
export async function lookup(
  runtime: Runtime,
  path: string,
  params: Record<string, string> = {},
): Promise<string> {
  const base = process.env.ATLAS_URL?.trim();
  const credential = runtime.context?.credential;
  if (!base || !credential) return UNREADABLE;

  const url = new URL(`/api/agent/${path}`, base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return typeof body?.error === "string" ? `Lookup failed: ${body.error}` : UNREADABLE;
    }
    if (!res.ok) return UNREADABLE;
    return await res.text();
  } catch {
    return UNREADABLE;
  }
}
