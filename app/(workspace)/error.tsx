"use client";

// A failed load says what failed and offers the one thing that might fix it.
// It never falls back to an empty dashboard, which would read as "no data".
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center pl-12 md:pl-0">
      <div role="alert" className="max-w-md rounded-card border border-border bg-surface p-6">
        <h1 className="text-base font-semibold tracking-tight">
          The dashboard couldn&apos;t load
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{error.message}</p>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Check your connection and try again. If it keeps failing, the database may
          be rejecting the session token.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 h-9 rounded-control bg-accent px-4 text-sm font-medium text-on-accent transition-transform duration-100 active:scale-[0.97]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
