// Whether an explained file still matches the repository. The stored content
// hash is compared with the file on the default branch now, and the commit
// analysed with the commit the branch points at.
//
// Plain server code: no Next, no React, runnable from a script.

import { readFileAt, resolveCommit, type RepoRef } from "./pipeline/github.ts";

export type Freshness =
  /** The default branch is still at the analysed commit. */
  | { state: "current" }
  /** The repository moved on, but this file's content is unchanged. */
  | { state: "moved"; head: string }
  /** The file's content differs from what was analysed and explained. */
  | { state: "changed"; head: string }
  /** The file no longer exists on the default branch. */
  | { state: "gone"; head: string }
  /** GitHub couldn't be asked; nothing is claimed either way. */
  | { state: "unknown"; reason: string };

// The default branch's commit, per repository, for a minute: opening several
// explanations in a row shouldn't spend GitHub's 60 unauthenticated requests
// an hour two at a time.
const HEAD_TTL_MS = 60_000;
const heads = new Map<string, { sha: string; at: number }>();

async function headOf(ref: RepoRef): Promise<string> {
  const key = `${ref.owner}/${ref.name}`.toLowerCase();
  const hit = heads.get(key);
  if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.sha;
  const { sha } = await resolveCommit(ref);
  heads.set(key, { sha, at: Date.now() });
  return sha;
}

export async function checkFreshness(ref: RepoRef, analysedCommit: string, path: string, storedSha256: string): Promise<Freshness> {
  try {
    const head = await headOf(ref);
    if (head === analysedCommit) return { state: "current" };
    const now = await readFileAt(ref, head, path);
    if (now === null) return { state: "gone", head };
    return { state: now.sha256 === storedSha256 ? "moved" : "changed", head };
  } catch (e) {
    return { state: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}
