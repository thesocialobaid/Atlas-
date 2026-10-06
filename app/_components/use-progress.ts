"use client";

import { useEffect, useRef, useState } from "react";
import { asProgress, useSupabase, type Progress } from "./use-supabase";

/** "connecting" until the channel is joined; "failed" carries the reason. */
export type Live = { state: "connecting" } | { state: "live" } | { state: "failed"; reason: string };

/** Rejoins after a dropped channel before calling it unavailable. */
const MAX_REJOINS = 4;

/**
 * Subscribes to one private progress topic and calls `onProgress` with each
 * update the database publishes.
 *
 * A dropped channel (a network blip, a socket closed under a backgrounded
 * tab) is rejoined with a growing pause, and `onResume` is called once it's
 * back, so whatever was published in the gap can be read once rather than
 * missed. Only repeated failure is reported, and then it's reported: a page
 * that simply stops updating looks exactly like a run that stopped.
 */
export function useProgress(
  topic: string | null,
  onProgress: (p: Progress) => void,
  onResume?: () => void,
): Live {
  const supabase = useSupabase();
  const [live, setLive] = useState<Live>({ state: "connecting" });
  // The latest callbacks, without resubscribing every render.
  const handlers = useRef({ onProgress, onResume });
  useEffect(() => {
    handlers.current = { onProgress, onResume };
  }, [onProgress, onResume]);

  useEffect(() => {
    if (!supabase || !topic) return;
    let cancelled = false;
    let current: ReturnType<typeof supabase.channel> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let drops = 0;

    // One path for every way a channel is lost: the token couldn't be fetched,
    // the join was refused, or the socket closed. Rejoin with a growing pause;
    // report only once rejoining has failed repeatedly.
    const dropped = (reason: string) => {
      drops++;
      if (drops > MAX_REJOINS) {
        setLive({ state: "failed", reason });
        return;
      }
      setLive({ state: "connecting" });
      retry = setTimeout(() => void join(), 1000 * drops);
    };

    const join = async () => {
      // Private channels are authorised by the token, which must be on the
      // socket before joining.
      try {
        await supabase.realtime.setAuth();
      } catch (e) {
        if (cancelled) return;
        console.warn(`[atlas] ${topic}: couldn't authorise`, e);
        dropped(e instanceof Error ? e.message : "couldn't authorise");
        return;
      }
      if (cancelled) return;
      const channel = supabase.channel(topic, { config: { private: true } });
      current = channel;
      channel.on("broadcast", { event: "progress" }, ({ payload }) => {
        const p = asProgress(payload);
        if (p) handlers.current.onProgress(p);
      });
      channel.subscribe((status, err) => {
        // Statuses from a channel this effect has already let go of.
        if (cancelled || channel !== current) return;
        if (status === "SUBSCRIBED") {
          if (drops > 0) handlers.current.onResume?.();
          drops = 0;
          setLive({ state: "live" });
          return;
        }
        if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT" && status !== "CLOSED") return;
        // The reason is otherwise lost: the page only says the updates stopped.
        console.warn(`[atlas] ${topic}: ${status}`, err ?? "");
        current = null;
        void supabase.removeChannel(channel);
        dropped(err?.message ?? status.toLowerCase().replace("_", " "));
      });
    };
    void join();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      if (current) void supabase.removeChannel(current);
    };
  }, [supabase, topic]);

  return live;
}
