"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useProgress } from "./use-progress";

/** Several stages can land within moments; they become one refresh. */
const SETTLE_MS = 400;

// Keeps the dashboard current while a run moves. The database publishes each
// change to this organization's topic; each burst re-renders the page on the
// server once. Nothing is read unless something changed.
export function LiveDashboard({ orgId }: { orgId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onProgress = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), SETTLE_MS);
  }, [router]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A rejoin after a dropped channel refreshes too: something may have moved
  // while nothing was listening.
  const live = useProgress(`org:${orgId}:analyses`, onProgress, onProgress);
  if (live.state !== "failed") return null;
  return (
    <p role="status" className="text-xs text-danger">
      Live updates unavailable ({live.reason}). Reload to see the latest.
    </p>
  );
}
