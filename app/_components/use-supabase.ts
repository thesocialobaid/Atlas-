"use client";

import { useAuth } from "@clerk/nextjs";
import { createClient } from "@supabase/supabase-js";
import { useMemo } from "react";
import type { Database } from "@/lib/database.types";

// The browser's Supabase client, signed in as the user. Clerk's session token
// travels with every request and opens the realtime socket, so private
// channels are authorised by the same organization claim as the row
// policies. A bare client would be refused by those policies, and its
// subscriptions would silently receive nothing.
//
// The browser only ever subscribes with this; it reads and writes nothing.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function useSupabase() {
  // Keyed on the session's id, not its object: Clerk hands out a new session
  // object each time it refreshes, and a client rebuilt on each refresh would
  // tear down every subscription with it. getToken is stable and always
  // returns a current token, read on every request and every realtime
  // heartbeat.
  const { sessionId, getToken } = useAuth();
  return useMemo(() => {
    if (!URL || !KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set.");
    if (!sessionId) return null;
    return createClient<Database>(URL, KEY, {
      // The realtime socket re-reads this every heartbeat (25 seconds), and a
      // Clerk token lives 60. A cached token near its end would expire before
      // the next heartbeat and the server would end the subscription, so one
      // with less than a heartbeat and a margin left is swapped for a new one.
      accessToken: async () => {
        const cached = await getToken();
        if (cached && secondsLeft(cached) > MIN_TOKEN_SECONDS) return cached;
        return (await getToken({ skipCache: true })) ?? null;
      },
    });
  }, [sessionId, getToken]);
}

/** A heartbeat's length plus room for a slow round trip. */
const MIN_TOKEN_SECONDS = 35;

/** Seconds until a JWT's exp, or 0 if it can't be read. */
function secondsLeft(jwt: string): number {
  try {
    const part = jwt.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/");
    if (!part) return 0;
    const claims: unknown = JSON.parse(atob(part));
    if (typeof claims !== "object" || claims === null || !("exp" in claims) || typeof claims.exp !== "number") return 0;
    return claims.exp - Date.now() / 1000;
  } catch {
    return 0;
  }
}

export type Progress = {
  analysis_id: string;
  status: string;
  stage: string | null;
  message: string | null;
};

/** The payload the database publishes; anything else on the topic is ignored. */
export function asProgress(payload: unknown): Progress | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("analysis_id" in payload) || !("status" in payload)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const id = str(payload.analysis_id);
  const status = str(payload.status);
  if (!id || !status) return null;
  return {
    analysis_id: id,
    status,
    stage: "stage" in payload ? str(payload.stage) : null,
    message: "message" in payload ? str(payload.message) : null,
  };
}
