// The run's stages, in order. Its own module so the browser can name them
// without importing the pipeline, and the parser with it.

export const STAGES = ["fetching", "selecting", "parsing", "storing"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  fetching: "Fetching the repository",
  selecting: "Selecting files",
  parsing: "Parsing imports",
  storing: "Storing the map",
};

export function isStage(value: string | null): value is Stage {
  return STAGES.some((s) => s === value);
}
