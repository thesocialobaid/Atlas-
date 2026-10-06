import Link from "next/link";
import { ago, formatSeconds, isStale, seconds } from "@/lib/dashboard-math";
import { isStage, STAGE_LABEL } from "@/lib/pipeline/stages";
import type { Dashboard } from "@/lib/analyses";
import { Card, EmptyNote } from "./card";
import { StateBadge } from "./state";

export function ReposTable({ repos, now }: { repos: Dashboard["repos"]; now: Date }) {
  return (
    <Card title="Repositories">
      {repos.length === 0 ? (
        <EmptyNote>Repositories appear here once someone in the team maps one.</EmptyNote>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-fg-muted">
                <th scope="col" className="px-5 py-2 font-medium">Repository</th>
                <th scope="col" className="px-3 py-2 font-medium">Latest analysis</th>
                <th scope="col" className="px-3 py-2 font-medium">Started</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Took</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => {
                const latest = repo.analyses[0];
                return (
                  <tr
                    key={repo.id}
                    className="border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-5 py-3">
                      {latest ? (
                        <Link href={`/analyses/${latest.id}`} className="font-mono text-[13px] hover:underline">
                          <span className="text-fg-muted">{repo.repo_owner}/</span>
                          {repo.repo_name}
                        </Link>
                      ) : (
                        <span className="font-mono text-[13px]">
                          <span className="text-fg-muted">{repo.repo_owner}/</span>
                          {repo.repo_name}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {latest ? (
                        <span className="inline-flex items-center gap-2">
                          <StateBadge state={isStale(latest, now) ? "stale" : latest.status} />
                          {latest.status === "running" && isStage(latest.stage) && !isStale(latest, now) && (
                            <span className="text-xs text-fg-muted">{STAGE_LABEL[latest.stage]}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-muted">Never analysed</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-fg-muted">
                      {latest ? <time dateTime={latest.created_at}>{ago(latest.created_at, now)}</time> : "—"}
                    </td>
                    <td className="px-5 py-3 text-right text-xs tabular-nums text-fg-muted">
                      {latest?.finished_at ? formatSeconds(seconds(latest.created_at, latest.finished_at)) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
