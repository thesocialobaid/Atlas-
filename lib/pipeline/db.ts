// The pipeline's database client, and the only one that holds the secret key.
//
// A run outlives the request that started it, and the Clerk token that request
// carried expires in about a minute, so the run can't write as the user. It
// writes as the server instead, stamping each row with the organization taken
// from the session when the run was started. Reading is still the policy's
// job: nothing that serves a page goes through this client.
//
// The secret key bypasses row-level security, so every query here names the
// organization or the analysis it means. That's the one place in the app where
// a filter decides which rows are touched, and it's confined to this module's
// callers in lib/pipeline.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../database.types.ts";
import { readEnv } from "../env.ts";

export function createPipelineDb() {
  const env = readEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type PipelineDb = ReturnType<typeof createPipelineDb>;
