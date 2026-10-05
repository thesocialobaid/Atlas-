import type { RepoFile } from "./types.ts";

/**
 * Framework knowledge lives here and nowhere in the parser. An adapter may
 * recognise a project and give files roles ("page", "route handler"); it never
 * adds or removes edges. Adapters beyond the fallback come in later phases.
 */
export type Adapter = {
  name: string;
  detects(files: readonly RepoFile[]): boolean;
  roleOf(file: RepoFile): string | null;
};

/** Assumes no framework at all: recognises nothing, labels nothing. */
export const noFramework: Adapter = {
  name: "none",
  detects: () => true,
  roleOf: () => null,
};

/** First adapter that recognises the project, else the fallback. */
export function pickAdapter(adapters: readonly Adapter[], files: readonly RepoFile[]): Adapter {
  return adapters.find((a) => a.detects(files)) ?? noFramework;
}
