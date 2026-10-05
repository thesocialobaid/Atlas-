import { ago } from "@/lib/dashboard-math";
import type { Dashboard } from "@/lib/analyses";
import { Card, EmptyNote } from "./card";
import { StateDot } from "./state";

const VERB: Record<string, string> = {
  complete: "Mapped",
  failed: "Failed to map",
  running: "Mapping",
  queued: "Queued",
};

export function Timeline({ recent, now }: { recent: Dashboard["recent"]; now: Date }) {
  return (
    <Card title="Recent activity">
      {recent.length === 0 ? (
        <EmptyNote>Nothing has run in this organization yet.</EmptyNote>
      ) : (
        <ol className="relative mx-5 mb-5 mt-4">
          {recent.map((a, i) => {
            const repo = a.project ? `${a.project.repo_owner}/${a.project.repo_name}` : "Unknown repository";
            const when = a.finished_at ?? a.created_at;
            return (
              <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
                {i < recent.length - 1 && (
                  <span aria-hidden="true" className="absolute left-[3px] top-4 h-full w-px bg-border" />
                )}
                <StateDot state={a.status} className="relative mt-1.5" />
                <div className="min-w-0">
                  <p className="text-sm">
                    {VERB[a.status] ?? a.status}{" "}
                    <span className="font-mono text-[13px]">{repo}</span>
                  </p>
                  {a.error && <p className="mt-0.5 text-xs text-danger">{a.error}</p>}
                  <time dateTime={when} className="text-xs text-fg-muted">
                    {ago(when, now)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
