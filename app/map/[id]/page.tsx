import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getAnalysis, getAnalysisMap } from "@/lib/analyses";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { MapShell } from "../../_components/map/shell";

export const metadata: Metadata = { title: "Map · Atlas" };

// A stored analysis, drawn. Everything the map shows comes from the rows the
// run stored, read through the organization's policy.
export default async function MapPage({ params }: PageProps<"/map/[id]">) {
  await connection();
  const { id } = await params;
  const loaded = await getAnalysisMap(id);
  if (!loaded) {
    // Not finished yet, or failed: its progress page says which. Absent or
    // another organization's: not found, the same for both.
    if (await getAnalysis(id)) redirect(`/analyses/${id}`);
    notFound();
  }
  const { analysis, input } = loaded;
  const name = analysis.project ? `${analysis.project.repo_owner}/${analysis.project.repo_name}` : "Unknown repository";
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return <MapShell analysisId={analysis.id} name={name} result={input} theme={theme} />;
}
