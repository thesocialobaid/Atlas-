// Loads the environment the web app runs with, for scripts that run outside
// it. Imported first, before anything that reads a variable at load time.
//
// Next reads these files, most important first, and never overrides a
// variable that's already set; process.loadEnvFile doesn't override either,
// so loading in the same order gives the same values. The mode is
// development unless NODE_ENV says otherwise, as under `next dev`, and test
// mode skips .env.local, as Next does.
//
// Not done: Next's $VARIABLE expansion inside values. Nothing here uses it.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test" ? process.env.NODE_ENV : "development";
const files = [`.env.${mode}.local`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}`, ".env"];

for (const name of files) {
  const path = root + name;
  if (existsSync(path)) process.loadEnvFile(path);
}
