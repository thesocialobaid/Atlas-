import { ago, formatSeconds, seconds } from "@/lib/dashboard-math";
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
                      <span className="font-mono text-[13px]">
                        <span className="text-fg-muted">{repo.repo_owner}/</span>
                        {repo.repo_name}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      {latest ? <StateBadge state={latest.status} /> : <span className="text-xs text-fg-muted">Never analysed</span>}
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
