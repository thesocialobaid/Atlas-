// The six lookups. Each one asks a question of the parsed analysis and returns
// what Atlas computed; none of them decides anything about the code itself.
// The agent chooses where to start and which way to go, and the same walk that
// draws blast radius on the canvas does the walking.

import { tool } from "langchain";
import { z } from "zod";

import { lookup, type Runtime } from "./atlas";

export const analysisSummary = tool(async (_input, runtime: Runtime) => lookup(runtime, "summary"), {
  name: "analysis_summary",
  description:
    "Overview of the whole analysis: the repository, how many files were found, parsed and skipped (with reasons), " +
    "the frameworks detected, the roles files were given, import coverage, and the notable files (imported by " +
    "unusually many files, imported by nothing, in import loops, very long). Start here when a question is about " +
    "the repository as a whole or you don't know where to look.",
  schema: z.object({}),
});

export const searchFiles = tool(async ({ text }, runtime: Runtime) => lookup(runtime, "files", { contains: text }), {
  name: "search_files",
  description:
    "Find files whose path contains some text, case-insensitive: a folder, a file name, or part of one " +
    '(e.g. "auth", "middleware", "api/users"). Returns each file with its role and import counts. Use it to turn ' +
    "a word in the question into real paths before asking about connections.",
  schema: z.object({ text: z.string().min(1).describe("Text to look for anywhere in a file's path.") }),
});

export const filesByRole = tool(async ({ role }, runtime: Runtime) => lookup(runtime, "files", { role }), {
  name: "files_by_role",
  description:
    'List every file with a given role, such as "page", "layout" or "route handler". Roles come from the analysis; ' +
    "analysis_summary lists the ones this repository has. An unknown role returns the roles that do exist.",
  schema: z.object({ role: z.string().min(1).describe("A role exactly as the analysis names it.") }),
});

export const neighbours = tool(async ({ path }, runtime: Runtime) => lookup(runtime, "neighbours", { path }), {
  name: "file_neighbours",
  description:
    "One file's direct connections: the files it imports and the files that import it, one step each way, " +
    "plus its imports that point outside the repository or couldn't be resolved, with the reason. Needs an exact " +
    "path; use search_files first if you only have part of one.",
  schema: z.object({ path: z.string().min(1).describe("Exact file path from the analysis.") }),
});

export const walk = tool(async ({ path, direction }, runtime: Runtime) => lookup(runtime, "walk", { path, direction }), {
  name: "walk_imports",
  description:
    'Follow imports from one file, several steps out. "dependents" walks to the files that import it, then the files ' +
    'that import those: what could break if it changes. "dependencies" walks the other way: what it needs to work. ' +
    "Each file reached comes with how many steps away it is. The walk's depth is fixed; the result says what it is.",
  schema: z.object({
    path: z.string().min(1).describe("Exact file path to start from."),
    direction: z.enum(["dependents", "dependencies"]),
  }),
});

export const routes = tool(async (_input, runtime: Runtime) => lookup(runtime, "routes"), {
  name: "list_routes",
  description:
    "The HTTP routes read from the code: method, full path and the file and line that declares each. Routes that " +
    "couldn't be read exactly are counted with the reason, never listed with a guessed path.",
  schema: z.object({}),
});

export const graphTools = [analysisSummary, searchFiles, filesByRole, neighbours, walk, routes];
