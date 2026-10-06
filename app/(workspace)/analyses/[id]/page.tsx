import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAnalysis } from "@/lib/analyses";
import { isStale } from "@/lib/dashboard-math";
import { Topbar } from "../../../_components/topbar";
import { ProgressView } from "./progress-view";

export const metadata: Metadata = { title: "Analysis · Atlas" };

// The run's progress, named stage by stage. The first paint is the row as it
// stands; from then on the database pushes each change and nothing is re-read.
export default async function AnalysisPage({ params }: PageProps<"/analyses/[id]">) {
  await connection();
  const { id } = await params;
  // Another organization's analysis is absent under the policy, and so is
  // shown the same way as one that doesn't exist.
  const analysis = await getAnalysis(id);
  if (!analysis) notFound();
  // A finished analysis is its map. Only runs still going, or that failed,
  // have anything to show here.
  if (analysis.status === "complete") redirect(`/map/${analysis.id}`);

  const repo = analysis.project ? `${analysis.project.repo_owner}/${analysis.project.repo_name}` : "Unknown repository";
  return (
    <div className="space-y-6">
      <Topbar title={repo} />
      {/* Keyed on the row's last movement: a re-read that finds it moved on
          starts the view from the newer row. */}
      <ProgressView
        key={`${analysis.status}:${analysis.progressed_at ?? ""}`}
        initial={analysis}
        staleAtLoad={isStale(analysis, new Date())}
      />
    </div>
  );
}
