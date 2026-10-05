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
