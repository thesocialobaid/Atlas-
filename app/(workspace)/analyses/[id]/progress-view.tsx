"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { AnalysisRow } from "@/lib/analyses";
import { STALE_MINUTES } from "@/lib/dashboard-math";
import { isStage, STAGE_LABEL, STAGES, type Stage } from "@/lib/pipeline/stages";
import { StateBadge } from "../../../_components/state";
import { useProgress } from "../../../_components/use-progress";
import type { Progress } from "../../../_components/use-supabase";

type View = {
  status: string;
  stage: Stage | null;
  /** The latest message each stage reported while this page was open. */
  messages: Partial<Record<Stage, string>>;
  /** The run's last word: its outcome when finished, its failure reason when failed. */
  outcome: string | null;
  /** Something arrived since load, so whatever made the row look stale is over. */
  moved: boolean;
};

function fromRow(row: AnalysisRow): View {
  const stage = isStage(row.stage) ? row.stage : null;
  return {
    status: row.status,
    stage,
    messages: stage && row.stage_message && row.status === "running" ? { [stage]: row.stage_message } : {},
    outcome: row.status === "failed" ? row.error : row.status === "complete" ? row.stage_message : null,
    moved: false,
  };
}

function apply(view: View, p: Progress): View {
  const stage = isStage(p.stage) ? p.stage : view.stage;
  const finished = p.status === "complete" || p.status === "failed";
  return {
    status: p.status,
    // Completion clears the stage on the row; keep the last one for display.
    stage: p.status === "complete" ? null : stage,
    messages: !finished && stage && p.message ? { ...view.messages, [stage]: p.message } : view.messages,
    outcome: finished ? p.message : null,
    moved: true,
  };
}

type Step = "done" | "current" | "failed" | "pending";

function stepOf(view: View, stage: Stage): Step {
  if (view.status === "complete") return "done";
  if (view.status === "queued" || view.stage === null) return "pending";
  const at = STAGES.indexOf(view.stage);
  const i = STAGES.indexOf(stage);
  if (i < at) return "done";
  if (i > at) return "pending";
  return view.status === "failed" ? "failed" : "current";
}

export function ProgressView({ initial, staleAtLoad }: { initial: AnalysisRow; staleAtLoad: boolean }) {
  const router = useRouter();
  const [view, setView] = useState(() => fromRow(initial));
  const onProgress = useCallback((p: Progress) => setView((v) => apply(v, p)), []);
  // After a dropped channel is rejoined, read the row once: a stage that
  // moved while nothing was listening would otherwise never be shown.
  const onResume = useCallback(() => router.refresh(), [router]);
  const finished = view.status === "complete" || view.status === "failed";
  // A finished run will never publish again; there's nothing to follow.
  const live = useProgress(finished && !view.moved ? null : `analysis:${initial.id}`, onProgress, onResume);
  const stale = staleAtLoad && !view.moved;

  // Storing is the last stage; once it's done the map exists, and that's
  // where the person was going. Replace, so Back doesn't return here.
  useEffect(() => {
    if (view.status === "complete") router.replace(`/map/${initial.id}`);
  }, [view.status, router, initial.id]);

  return (
    <section className="rounded-card border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          <StateBadge state={stale ? "stale" : view.status} />
          {initial.commit_sha && (
            <span>
              at <span className="font-mono text-fg">{initial.commit_sha.slice(0, 7)}</span>
            </span>
          )}
        </div>
        {!finished && (
          <p className={`text-xs ${live.state === "failed" ? "text-danger" : "text-fg-muted"}`}>
            {live.state === "live" && "Updates as each stage moves"}
            {live.state === "connecting" && "Connecting for updates"}
            {live.state === "failed" && `Live updates unavailable (${live.reason}). Reload to see the latest.`}
          </p>
        )}
      </header>

      <ol className="px-5 py-2">
        {STAGES.map((stage) => {
          const step = stepOf(view, stage);
          const message = step === "failed" ? view.outcome : view.messages[stage];
          return (
            <li
              key={stage}
              aria-current={step === "current" ? "step" : undefined}
              className="flex items-start gap-3 border-b border-border py-2.5 last:border-0"
            >
              <Marker step={step} />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${step === "pending" ? "text-fg-muted" : ""} ${step === "current" ? "font-medium" : ""}`}>
                  {STAGE_LABEL[stage]}
                </p>
                {message && (
                  <p className={`mt-0.5 font-mono text-xs ${step === "failed" ? "text-danger" : "text-fg-muted"}`}>
                    {message}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <footer className="border-t border-border px-5 py-3 text-sm">
        {view.status === "queued" && !stale && <p className="text-fg-muted">Waiting to start.</p>}
        {stale && (
          <p className="text-fg-muted">
            No progress for over {STALE_MINUTES} minutes. The run has most likely stopped; it won&apos;t finish on its
            own.
          </p>
        )}
        {view.status === "complete" && (
          <p>
            {view.outcome ?? "Complete."} Opening the map.{" "}
            <Link href={`/map/${initial.id}`} className="text-fg-muted underline underline-offset-2">
              Open it now
            </Link>
          </p>
        )}
        {view.status === "failed" && (
          <p className="text-fg-muted">
            Stopped while {view.stage ? STAGE_LABEL[view.stage].toLowerCase() : "starting"}.{" "}
            <Link href="/" className="text-fg underline underline-offset-2">
              Back to the dashboard
            </Link>
          </p>
        )}
      </footer>
    </section>
  );
}

function Marker({ step }: { step: Step }) {
  if (step === "done") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-label="Done" className="mt-0.5 shrink-0 text-fg-muted">
        <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const style =
    step === "current"
      ? "bg-accent"
      : step === "failed"
        ? "bg-danger"
        : "border border-fg-muted bg-transparent";
  const label = step === "current" ? "In progress" : step === "failed" ? "Failed" : "Not started";
  return (
    <span className="mt-1 flex size-3.5 shrink-0 items-center justify-center" role="img" aria-label={label}>
      <span className={`size-2 rounded-full ${style}`} />
    </span>
  );
}
