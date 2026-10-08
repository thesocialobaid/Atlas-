import type { Theme } from "@/lib/theme";
import type { MapInput } from "@/lib/map/input";
import { Workspace } from "./workspace";

// The map's three columns: rail, canvas, detail pane. Fixed here; later phases
// fill them and never move them. The workspace draws all three, because the
// rail's filter, the map and the pane share state.
export function MapShell({
  analysisId,
  name,
  result,
  theme,
}: {
  analysisId: string;
  name: string;
  result: MapInput;
  theme: Theme;
}) {
  return (
    <div className="grid h-screen grid-cols-[192px_minmax(0,1fr)_320px] overflow-hidden text-[13px]">
      <Workspace analysisId={analysisId} name={name} result={result} theme={theme} />
    </div>
  );
}
