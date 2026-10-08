// The model's answers, cached by what it was shown. Reads and writes go
// through whichever database client the caller holds: a member's, for an
// explanation they asked for (the policy decides the organization), or the
// pipeline's, for labels written during a run.
//
// Plain server code: no Next, no React, runnable from a script.

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.ts";
import { MODEL, traced } from "./client.ts";

export type Db = SupabaseClient<Database>;
export type CacheKind = "file" | "folder" | "label";

/**
 * The key: the kind, the pinned model, the prompt's version and everything
 * handed to the model, hashed. Anything that would change the answer changes
 * the key; nothing else does.
 */
export function cacheKey(kind: CacheKind, promptVersion: number, shown: unknown): string {
  return createHash("sha256").update(JSON.stringify({ kind, model: MODEL, promptVersion, shown })).digest("hex");
}

/**
 * Cached bodies for these keys, in this organization. Its own traced step,
 * always called inside the traced operation it serves: a hit then shows as a
 * run that read the cache and called no model.
 *
 * The organization filter is not redundant. A member's client is already held
 * to their organization by the policy, but the pipeline reads with the secret
 * key, which bypasses it. Keys are hashes of public content, so without the
 * filter one organization could plant an answer another organization's run
 * would read as its own.
 */
export async function readCache(db: Db, orgId: string, keys: string[]): Promise<Map<string, string>> {
  // The database client stays out of the trace: only the keys are recorded.
  const read = traced("cache read", async (asked: string[]) => {
    // A plain object rather than a Map, so the trace shows which keys hit.
    const found: Record<string, string> = {};
    // Keys are hashes; a batch of labels asks for at most a few dozen at once.
    for (let i = 0; i < asked.length; i += 200) {
      const { data, error } = await db
        .from("model_cache")
        .select("cache_key, body")
        .eq("org_id", orgId)
        .in("cache_key", asked.slice(i, i + 200))
        .limit(200);
      if (error) throw new Error(`Couldn't read the cache: ${error.message}`);
      for (const row of data) found[row.cache_key] = row.body;
    }
    return { hits: found };
  }, "retriever");
  return new Map(Object.entries((await read(keys)).hits));
}

/**
 * Stores answers. Two people asking at the same moment write the same key
 * twice; the second insert is ignored, since both wrote the same answer to
 * the same question.
 */
export async function writeCache(db: Db, orgId: string, kind: CacheKind, rows: { key: string; body: string }[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db
    .from("model_cache")
    .upsert(
      rows.map((r) => ({ org_id: orgId, kind, cache_key: r.key, model: MODEL, body: r.body })),
      { onConflict: "org_id,cache_key", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Couldn't store the answer: ${error.message}`);
}
