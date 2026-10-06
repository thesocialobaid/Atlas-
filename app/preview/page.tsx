import type { Metadata } from "next";
import { cookies } from "next/headers";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { preview, PREVIEW_NAME } from "@/lib/preview/data";
import { MapShell } from "../_components/map/shell";

export const metadata: Metadata = { title: `${PREVIEW_NAME} · Atlas preview` };

// Scaffolding: the real interface over checked-in parser output, so the map can
// be built without a database. Deleted in phase 7.
export default async function PreviewPage() {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return <MapShell name={PREVIEW_NAME} result={preview} theme={theme} />;
}
