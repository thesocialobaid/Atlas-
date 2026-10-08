// What the map reads: the parser's output, minus what the map never uses.
//
// `imports` holds the imports that didn't become edges (external, excluded,
// unresolved), each with its reason; resolved imports are the edges. Stored
// analyses keep only those, and a full parse result still fits this shape.

import type { ParseResult } from "../../parser/types.ts";

export type MapInput = Pick<ParseResult, "files" | "edges" | "imports" | "fan" | "coverage" | "adapters" | "routes"> & {
  /** Null for an analysis stored before routes were read. */
  routesWithheld: ParseResult["routesWithheld"] | null;
};
