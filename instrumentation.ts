import { readEnv } from "./lib/env";

// Runs once before the server takes its first request: a missing variable
// crashes boot instead of producing a confusing error several screens later.
export function register() {
  readEnv();
}
