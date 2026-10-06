"use client";

import { createContext, useContext } from "react";

export type Selection = { kind: "group"; dir: string } | { kind: "file"; path: string } | null;

/**
 * The files the pointer is over, and which side it's over. Each side only
 * draws the other's hover: the side under the pointer already shows its own.
 */
export type Hover = { from: "map" | "pane"; paths: ReadonlySet<string> } | null;

export type HoverApi = { hover: Hover; setHover: (h: Hover) => void };

// Hover travels by context rather than node data, so moving the pointer
// re-renders the nodes that read it and never rebuilds React Flow's node list.
export const HoverContext = createContext<HoverApi>({ hover: null, setHover: () => {} });

export const useHover = () => useContext(HoverContext);

/** True when the pane is pointing at any of these files. */
export function paneHovers(hover: Hover, paths: readonly string[]): boolean {
  return hover?.from === "pane" && paths.some((p) => hover.paths.has(p));
}
