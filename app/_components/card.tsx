import type { ReactNode } from "react";

export function Card({
  title,
  aside,
  children,
  className = "",
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col rounded-card border border-border bg-surface ${className}`}
    >
      {title && (
        <header className="flex items-baseline justify-between gap-4 px-5 pt-5">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {aside && <div className="text-xs text-fg-muted">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** For a card whose data doesn't exist yet: say so, and what makes it appear. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center px-5 py-10 text-center text-sm text-fg-muted">
      {children}
    </p>
  );
}
