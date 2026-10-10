import { defineDeepAgent } from "managed-deepagents";

import { onlyLookups } from "./middleware/only-lookups";
import { contextSchema } from "./tools/atlas";
import { graphTools } from "./tools/graph";

// The free-tier lite model, the same one Atlas explains files with: the larger
// Flash models are often refused for demand on that key.
export const agent = defineDeepAgent({
  name: "atlas-ask",
  model: "google-genai:gemini-3.5-flash-lite",
  tools: graphTools,
  contextSchema,
  middleware: [onlyLookups],
});
