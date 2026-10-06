import { auth } from "@clerk/nextjs/server";
import { connection } from "next/server";
import { getDashboard } from "@/lib/analyses";
import { formatSeconds, median, perDay, seconds } from "@/lib/dashboard-math";
import { Card, EmptyNote } from "../_components/card";
import { AnalyseForm } from "../_components/analyse-form";
import { DailyBars, DurationBars } from "../_components/charts";
import { IntroCards } from "../_components/intro-cards";
import { LiveDashboard } from "../_components/live-dashboard";
import { ReposTable } from "../_components/repos-table";
import { StatCard, Sparkline } from "../_components/stat-card";
import { StateDot, stateLabel } from "../_components/state";
import { Timeline } from "../_components/timeline";
import { Topbar } from "../_components/topbar";

export default async function DashboardPage() {
  await connection();
  const now = new Date();
  // A failed query throws to the error boundary rather than rendering as an
  // empty dashboard: "nothing yet" and "couldn't ask" must never look alike.
  const data = await getDashboard(now);
  const { orgId } = await auth();
  const { counts } = data;
  const total = counts.queued + counts.running + counts.complete + counts.failed;
  const inProgress = counts.queued + counts.running;

  const days = perDay(data.activity.rows.map((r) => r.created_at), now, data.activityDays);
  const lastWeek = days.slice(-7).reduce((sum, d) => sum + d.count, 0);

  const finished = data.recent
    .filter((a) => a.finished_at)
    .map((a) => ({
      label: a.project ? `${a.project.repo_owner}/${a.project.repo_name}` : "Unknown",
      seconds: seconds(a.created_at, a.finished_at ?? a.created_at),
      failed: a.status === "failed",
    }));
  const completedDurations = finished.filter((f) => !f.failed).map((f) => f.seconds);
  const typical = median(completedDurations);

  return (
    <div className="space-y-6">
      <Topbar title="Dashboard" />

      <AnalyseForm />
      {orgId && <LiveDashboard orgId={orgId} />}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Analyses"
          value={total}
          note={`${lastWeek} started in the last 7 days`}
          chart={<Sparkline values={days.map((d) => d.count)} />}
        />
        <StatCard label="Repositories" value={data.repoCount} note="Mapped by this organization" />
        <StatCard
          label="In progress"
          value={inProgress}
          note={`${counts.running} running, ${counts.queued} queued`}
        />
        <StatCard
          label="Failed"
          value={counts.failed}
          note={counts.failed ? "Each one lists its reason below" : "None so far"}
        />
      </div>

      <IntroCards />

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Card title="Analyses started" aside={`Last ${data.activityDays} days, UTC`}>
          <div className="px-5 pt-4">
            <DailyBars days={days} />
            {data.activity.truncated && (
              <p className="mt-2 text-xs text-fg-muted">
                Showing the first 1,000 analyses in this period.
              </p>
            )}
          </div>
          <dl className="mt-auto grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
            {(["complete", "running", "queued", "failed"] as const).map((state) => (
              <div key={state} className="bg-surface px-5 py-4 first:rounded-bl-card last:rounded-br-card">
                <dt className="flex items-center gap-2 text-xs text-fg-muted">
                  <StateDot state={state} />
                  {stateLabel(state)}
                </dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">{counts[state]}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card
          title="Time to map"
          aside={typical === null ? undefined : `Typically ${formatSeconds(typical)}`}
        >
          {finished.length === 0 ? (
            <EmptyNote>Durations appear once an analysis finishes.</EmptyNote>
          ) : (
            <div className="px-5 pb-5 pt-5">
              <DurationBars rows={finished} />
              <p className="mt-5 text-xs text-fg-muted">
                From the {finished.length} most recent finished{" "}
                {finished.length === 1 ? "analysis" : "analyses"}. Red bars failed partway.
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[13fr_7fr]">
        <ReposTable repos={data.repos} now={now} />
        <Timeline recent={data.recent} now={now} />
      </div>
    </div>
  );
}
