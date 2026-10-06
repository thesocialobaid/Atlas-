"use client";

import { useActionState } from "react";
import { analyseRepository, type AnalyseState } from "../(workspace)/actions";

const INITIAL: AnalyseState = { error: null, input: "" };

// Paste a public repository; land on its progress, or on the analysis it
// already has. The error says what to change, under the field it's about.
export function AnalyseForm() {
  const [state, action, pending] = useActionState(analyseRepository, INITIAL);
  return (
    <section className="rounded-card border border-border bg-surface p-5">
      <form action={action} className="flex flex-col gap-2">
        <label htmlFor="repo-url" className="text-sm font-medium">
          Map a public GitHub repository
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="repo-url"
            name="url"
            type="text"
            required
            defaultValue={state.input}
            placeholder="github.com/owner/name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "repo-url-error" : "repo-url-hint"}
            className={`h-9 min-w-0 flex-1 rounded-control border bg-bg px-3 font-mono text-[13px] placeholder:text-fg-muted ${
              state.error ? "border-danger" : "border-border"
            }`}
          />
          <button
            type="submit"
            disabled={pending}
            className="h-9 shrink-0 rounded-control bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            {pending ? "Starting…" : "Map repository"}
          </button>
        </div>
        {state.error ? (
          <p id="repo-url-error" role="alert" className="text-xs text-danger">
            {state.error}
          </p>
        ) : (
          <p id="repo-url-hint" className="text-xs text-fg-muted">
            A repository this organization has already mapped opens its existing analysis.
          </p>
        )}
      </form>
    </section>
  );
}
