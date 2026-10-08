// Everything the run asks of GitHub. No token is sent or stored: a public
// repository's archive needs none, and asking for repository scope would be
// asking for more than this app ever uses.
//
// Nothing here fetches a URL the user typed. The input is reduced to an owner
// and a repository name, and every request is built from those against
// GitHub's own hosts, so a pasted link can't point the server anywhere else.

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { x as extract } from "tar";

export type RepoRef = { owner: string; name: string };

// The same shapes the projects table accepts.
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Bigger than this and the download stops: it's not a repository to read. */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * The archive limit counts compressed bytes, and repetitive content compresses
 * to almost nothing: a small archive can unpack to gigabytes. What's written
 * to disk is limited separately, by size and by number of files.
 */
export const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
export const MAX_UNPACKED_FILES = 200_000;

/** A failure whose message is written for the person who pasted the URL. */
export class RunError extends Error {}

/**
 * "owner/name", or a github.com link to the repository or anything inside it
 * (a branch, a file). Anything else is refused with what was expected.
 */
export function parseRepoUrl(input: string): RepoRef {
  const trimmed = input.trim();
  let path = trimmed;
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(trimmed)) {
    path = trimmed.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[^/]+\.[a-z]{2,}\//i.test(trimmed)) {
    throw new RunError("Only repositories on github.com can be analysed.");
  }
  const [owner, rawName] = path.split(/[/?#]/);
  const name = rawName?.replace(/\.git$/i, "");
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    throw new RunError(`"${trimmed}" isn't a GitHub repository. Paste github.com/owner/name.`);
  }
  return { owner, name };
}

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "atlas",
};

async function explain(res: Response, ref: RepoRef): Promise<never> {
  const repo = `github.com/${ref.owner}/${ref.name}`;
  if (res.status === 404) throw new RunError(`${repo} doesn't exist, or isn't public.`);
  if (res.status === 451) throw new RunError(`${repo} is unavailable for legal reasons.`);
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toISOString()}` : " later";
    throw new RunError(`GitHub's limit for unauthenticated requests was reached. Try again${when}.`);
  }
  if (res.status === 409) throw new RunError(`${repo} is empty: it has no commits to read.`);
  throw new RunError(`GitHub answered ${res.status} ${res.statusText} for ${repo}.`);
}

/**
 * The commit the default branch points at now, and the repository's own
 * spelling of its name. The archive is then fetched by that commit, so what's
 * parsed is exactly what's recorded, even if someone pushes in between.
 */
export async function resolveCommit(ref: RepoRef): Promise<{ ref: RepoRef; sha: string }> {
  const base = `https://api.github.com/repos/${ref.owner}/${ref.name}`;
  const repoRes = await fetch(base, { headers: API_HEADERS, redirect: "follow" });
  if (!repoRes.ok) return explain(repoRes, ref);
  const repo = (await repoRes.json()) as { name?: unknown; owner?: { login?: unknown }; default_branch?: unknown; private?: unknown };
  if (repo.private === true) throw new RunError(`github.com/${ref.owner}/${ref.name} is private.`);
  if (typeof repo.default_branch !== "string" || typeof repo.name !== "string" || typeof repo.owner?.login !== "string") {
    throw new RunError("GitHub's description of the repository was missing its name or default branch.");
  }
  // A renamed or transferred repository redirects; its current name is the
  // one worth recording.
  const canonical = { owner: repo.owner.login, name: repo.name };

  const commitRes = await fetch(
    `https://api.github.com/repos/${canonical.owner}/${canonical.name}/commits/${encodeURIComponent(repo.default_branch)}`,
    { headers: { ...API_HEADERS, Accept: "application/vnd.github.sha" } },
  );
  if (!commitRes.ok) return explain(commitRes, canonical);
  const sha = (await commitRes.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new RunError("GitHub didn't return a commit for the default branch.");
  return { ref: canonical, sha };
}

/**
 * Downloads the archive of one commit and unpacks it into `dir`, dropping the
 * archive's single top-level folder so `dir` is the repository root.
 *
 * Only regular files and folders are written. Symbolic links are left out:
 * one pointing outside the repository would otherwise let the parser read a
 * file on this server. The count of what was left out is returned so it can
 * be reported rather than lost.
 */
export async function downloadArchive(ref: RepoRef, sha: string, dir: string): Promise<{ links: number }> {
  // codeload is where GitHub serves archives; asking it directly avoids
  // following a redirect from the API to somewhere not chosen here.
  const res = await fetch(`https://codeload.github.com/${ref.owner}/${ref.name}/tar.gz/${sha}`, {
    headers: { "User-Agent": "atlas" },
    redirect: "error",
  });
  if (!res.ok || !res.body) return explain(res, ref);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new RunError(`The archive is ${Math.round(declared / 1024 / 1024)} MB; the limit is ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  }

  // The declared length can be absent, so the bytes are counted as they
  // arrive too, and the download stops the moment it passes the limit.
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) {
        done(new RunError(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`));
      } else done(null, chunk);
    },
  });

  let links = 0;
  let unpackedBytes = 0;
  let unpackedFiles = 0;
  // Each entry's size is in its header, so the total is known before its bytes
  // are written; the unpack stops the moment it would pass a limit.
  const unpack = extract({
    cwd: dir,
    strip: 1,
    filter: (_path, entry) => {
      const type = "type" in entry ? entry.type : null;
      if (type === "File" || type === "OldFile" || type === "ContiguousFile" || type === "Directory") {
        unpackedBytes += entry.size;
        unpackedFiles++;
        if (unpackedBytes > MAX_UNPACKED_BYTES || unpackedFiles > MAX_UNPACKED_FILES) {
          unpack.abort(
            new RunError(
              `The repository unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024 / 1024} GB or ${MAX_UNPACKED_FILES.toLocaleString("en-US")} files.`,
            ),
          );
          return false;
        }
        return true;
      }
      if (type === "SymbolicLink" || type === "Link") links++;
      return false;
    },
  });
  await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), limit, unpack);
  return { links };
}

/** Larger than this, the parser skipped the file too: there's no source worth reading. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * One file's bytes at a commit (or "HEAD", the default branch now), with
 * their sha256, so the caller can check them against the hash stored at
 * analysis time. Null when the file doesn't exist there. raw.githubusercontent
 * serves public files without counting against the API's hourly limit.
 */
export async function readFileAt(ref: RepoRef, commit: string, path: string): Promise<{ text: string; sha256: string } | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://raw.githubusercontent.com/${ref.owner}/${ref.name}/${commit}/${encoded}`, {
    headers: { "User-Agent": "atlas" },
    redirect: "error",
  });
  if (res.status === 404) return null;
  if (!res.ok) return explain(res, ref);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw new RunError(`${path} is larger than 1 MB.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new RunError(`${path} is larger than 1 MB.`);
  return { text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
