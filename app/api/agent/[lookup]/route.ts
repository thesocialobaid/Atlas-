// The agent's read-only surface: six lookups over one analysis, reached with a
// credential rather than a signed-in member. GET only; nothing here writes.
//
// Only a 400 is worded for the model to read: it's about the question asked.
// The rest are for whoever reads the logs; the agent replaces them with one
// plain sentence, so nothing about credentials ever reaches an answer.
//
// Which analysis is read is never a parameter. The bearer credential names
// it, the database checks the signature, and its policies return that
// analysis or nothing. A request can't point this route anywhere else.

import type { NextRequest } from "next/server";
import { getCredentialAnalysisMap } from "@/lib/analyses";
import * as lookups from "@/lib/agent/lookups";
import type { Direction } from "@/lib/map/graph";

const DIRECTIONS: readonly Direction[] = ["dependents", "dependencies"];

function answer(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function param(req: NextRequest, name: string): string {
  const value = req.nextUrl.searchParams.get(name);
  if (value === null || value.trim() === "") throw new lookups.LookupError(`"${name}" is required.`);
  return value;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/agent/[lookup]">) {
  const { lookup } = await ctx.params;
  const credential = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!credential) return answer(401, { error: "No credential." });

  const loaded = await getCredentialAnalysisMap(credential);
  if (!loaded) {
    return answer(403, { error: "This credential doesn't open an analysis: it has expired, been altered, or the analysis is gone." });
  }
  const { analysis, input } = loaded;
  const p = lookups.prepare(input);

  try {
    switch (lookup) {
      case "summary":
        return answer(200, lookups.summary(p, {
          owner: analysis.project?.repo_owner ?? "unknown",
          name: analysis.project?.repo_name ?? "unknown",
          commit: analysis.commit_sha,
        }));
      case "files": {
        const role = req.nextUrl.searchParams.get("role");
        return answer(200, role !== null ? lookups.filesByRole(p, role) : lookups.searchFiles(p, param(req, "contains")));
      }
      case "neighbours":
        return answer(200, lookups.neighbours(p, param(req, "path")));
      case "walk": {
        const direction = param(req, "direction");
        if (!DIRECTIONS.includes(direction as Direction)) {
          throw new lookups.LookupError(`"direction" is "dependents" or "dependencies".`);
        }
        return answer(200, lookups.walk(p, param(req, "path"), direction as Direction));
      }
      case "routes":
        return answer(200, lookups.routes(p));
      default:
        return answer(404, { error: `No lookup called "${lookup}".` });
    }
  } catch (error) {
    if (error instanceof lookups.LookupError) return answer(400, { error: error.message });
    throw error;
  }
}
