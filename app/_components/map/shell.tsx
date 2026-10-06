import type { Theme } from "@/lib/theme";
import type { ParseResult } from "@/parser/types";
import { Workspace } from "./workspace";

// The map's three columns: rail, canvas, detail pane. Fixed here; later phases
// fill them and never move them. The workspace draws all three, because the
// rail's filter, the map and the pane share state.
export function MapShell({ name, result, theme }: { name: string; result: ParseResult; theme: Theme }) {
  return (
    <div className="grid h-screen grid-cols-[192px_minmax(0,1fr)_320px] overflow-hidden text-[13px]">
      <Workspace name={name} result={result} theme={theme} />
    </div>
  );
}
