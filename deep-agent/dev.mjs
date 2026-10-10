// `npm run dev`: what `mda dev` does, working on Windows.
//
// `mda dev` compiles the project into .mda/build, writes its environment
// (our .env plus the local secrets it injects), then launches the LangGraph dev
// server with `npx`. On Windows that last step fails: npx is `npx.cmd` there,
// and mda looks for an executable called `npx`. So mda does the preparing, and
// this script does the launching, with the exact command mda would have run.
// Any other failure stops here with mda's own message.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const PORT = "2024";
const NPX_BUG = "could not find `npx`";

const prepare = spawnSync("mda", ["dev", "--no-browser", "--no-reload", "--port", PORT], {
  cwd: root,
  encoding: "utf8",
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const output = `${prepare.stdout}${prepare.stderr}`;
if (prepare.status !== 0 && !output.includes(NPX_BUG)) {
  process.stderr.write(output);
  process.exit(prepare.status ?? 1);
}
if (prepare.status === 0) {
  // mda launched and ran the server itself: nothing left to do.
  process.exit(0);
}

const server = spawn("npx", ["--yes", "@langchain/langgraph-cli@^1.5.1", "dev", "--port", PORT, "--no-browser", "--no-reload"], {
  cwd: `${root}.mda/build`,
  shell: true,
  stdio: "inherit",
});
server.on("exit", (code) => process.exit(code ?? 1));
