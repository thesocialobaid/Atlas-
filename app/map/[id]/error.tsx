"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition } from "react";

// A map that couldn't load says what failed, never an empty canvas, which
// would read as a repository with nothing in it. Retrying re-reads the rows.
export default function MapError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <div className="flex h-screen items-center justify-center bg-bg px-4">
      <div role="alert" className="max-w-md rounded-card border border-border bg-surface p-6">
        <h1 className="text-base font-semibold tracking-tight">The map couldn&apos;t load</h1>
        <p className="mt-2 font-mono text-xs leading-relaxed text-fg-muted">{error.message}</p>
        <div className="mt-5 flex items-center gap-4">
          <button
            type="button"
            onClick={retry}
            className="h-9 rounded-control bg-accent px-4 text-sm font-medium text-on-accent"
          >
            Try again
          </button>
          <Link href="/" className="text-sm text-fg-muted underline underline-offset-2 hover:text-fg">
            Back to the dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
