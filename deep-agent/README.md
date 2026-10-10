# deep-agent

A Managed Deep Agent built with [`managed-deepagents`](https://github.com/langchain-ai/managed-deepagents-sdk).

## Project structure

```text
deep-agent/
  agent.ts         # defineDeepAgent(...) — required `name` is the deploy id
  instructions.md  # always-loaded system prompt
  package.json     # project dependencies
  .env             # API keys (LangSmith + model providers); never commit
  identity.ts      # managed authentication
  tools/           # optional custom tools
  middleware/      # optional middleware
  skills/          # optional skills synced to Context Hub
  tools/mcp.ts     # optional MCP server declaration
```

## Install

```bash
npm install
```

## Evaluate

From the project root, initialize the Harbor eval workspace:

```bash
mda evals init -i
```

Follow the coding-agent prompt to author tasks directly under `evals/<task>/`. The CLI
creates `evals/harbor-job.json` once and preserves your edits; `.mda/evals/` is generated.

A task may include an authored `evals/<task>/identity.json` fixture. It requires a
non-empty `user.id`; `user.kind`, `user.email`, and top-level `groups`, `claims`, and
`source.provider` are optional. Keep the fixture with the task, not in generated
`.mda/evals/`.

Running evals requires `uv` and Docker. Export `LANGSMITH_API_KEY`,
`LANGSMITH_WORKSPACE_ID` when your credentials require it, and the model or tool
credential variables used by the agent. Then run the pinned two-plugin Harbor command
included at the end of the coding-agent prompt from the project root. It uses POSIX
syntax on macOS/Linux and PowerShell on native Windows. `MDAJobPlugin` compiles a fresh
eval artifact at every Harbor job start. From the same project root, inspect results:

```bash
uv run --python 3.12 --with 'harbor[langsmith]==0.21.0' harbor view .mda/evals/jobs
```

This POC keeps MDA's custom Harbor adapter. Migration to Harbor's built-in LangGraph
agent is deferred.

## Develop

Edit `agent.ts` to configure your model, tools, and middleware, and edit
`instructions.md` to shape the system prompt.

Run the compiled app on the local LangGraph dev server:

```bash
mda dev
```

## Identity

`identity.ts` enables managed authentication: threads are owned
per caller. Set `auth` to one or more `auth.*` entries if browsers call
the deployment directly. Durable memory is declared separately.

## Memory

No `memory.ts`, so the agent keeps nothing between conversations.

## Sandbox

This project has no sandbox: MDA only provisions one when a declaration
is present. Add `sandbox/index.ts` to give the agent a managed execution
environment with a filesystem and a shell.

## Optional Runtime Pieces

Add `tools/mcp.ts` to attach MCP servers. The file must expose a named `mcp`
declaration.

## Deploy

Compile and deploy the project to LangSmith:

```bash
mda deploy
```

This copies your files verbatim, generates a managed entry module, and writes a
deployable build (including `langgraph.json`) to `.mda/build`. The CLI uploads
that build to LangSmith to run your agent on the managed runtime.

Common options:

```bash
mda deploy --name deep-agent-dev --deployment-type dev
mda deploy --workspace-id "$LANGSMITH_WORKSPACE_ID"
mda deploy --no-wait
```

Deploy prints both the Agent Server URL to call and the LangSmith dashboard URL
to inspect.

## Logs

Read the deployed agent's server logs:

```bash
mda logs
mda logs --lines 200 --level error
```

In a terminal this streams new output until you press Ctrl-C. When the output is
piped or redirected it prints the most recent lines (1000 by default) and exits.

## Delete

Remove the deployment and the LangSmith resources it created:

```bash
mda delete
```

This deletes the deployment, the tracing project created alongside it, the
Context Hub repo holding this agent's context and memory, and the managed
sandboxes this agent created. It asks first; pass `--yes` to skip the prompt.
Agent memory and thread history are not recoverable afterwards.

## Environment

`mda deploy` loads `.env`, uses `LANGSMITH_API_KEY` for LangSmith, and forwards
model provider keys such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` as deployment
secrets. Provider keys must be in `.env` or configured as LangSmith workspace
secrets — a value exported in your shell is not read. Set
`LANGSMITH_WORKSPACE_ID` or pass `--workspace-id` if your LangSmith API key
requires a workspace selection.
