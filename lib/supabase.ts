import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { readEnv } from "./env";

// Server-only. Supabase never runs its own session: Clerk owns the cookie and
// the proxy slot, and its session token is attached to every request so row
// policies can read the organization claim. Supabase trusts that token through
// its Clerk third-party auth integration.
export function createSupabase() {
  const env = readEnv();
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      accessToken: async () => (await auth()).getToken(),
    },
  );
}

export type Db = ReturnType<typeof createSupabase>;

/**
 * Reads as the agent's credential instead of a signed-in member: the
 * publishable key, which reads nothing on its own, plus the credential in a
 * header. The database checks its signature and its policies return the one
 * analysis it names. This client holds nothing that could read more.
 */
export function createCredentialSupabase(credential: string): Db {
  const env = readEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { "x-atlas-credential": credential } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
