// The two cards that say what Atlas is. The drawing is the one decorative
// element on the page, and it still uses the map's real colour meanings.

function MiniMap() {
  return (
    <svg viewBox="0 0 200 132" className="h-auto w-full max-w-[220px]" aria-hidden="true">
      <g fill="none" strokeWidth="1.5">
        <path d="M58 30 C 85 30, 85 66, 104 66" stroke="var(--incoming)" />
        <path d="M58 102 C 85 102, 85 66, 104 66" stroke="var(--incoming)" />
        <path d="M150 66 C 162 66, 160 30, 172 30" stroke="var(--outgoing)" />
        <path d="M150 66 C 162 66, 160 102, 172 102" stroke="var(--outgoing)" />
      </g>
      <g fill="var(--surface)" stroke="var(--border)">
        <rect x="8" y="16" width="50" height="28" rx="6" />
        <rect x="8" y="88" width="50" height="28" rx="6" />
        <rect x="172" y="16" width="22" height="28" rx="6" />
        <rect x="172" y="88" width="22" height="28" rx="6" />
      </g>
      <rect x="104" y="50" width="46" height="32" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
      <g fill="var(--fg-muted)">
        <rect x="16" y="27" width="28" height="4" rx="2" />
        <rect x="16" y="99" width="22" height="4" rx="2" />
      </g>
      <rect x="113" y="63" width="28" height="5" rx="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function IntroCards() {
  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      <section className="flex flex-col gap-6 rounded-card border border-border bg-surface p-6 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">See the shape of a codebase</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-fg-muted">
            Atlas reads every import in a public repository and draws it as a map:
            folders as boxes, imports as the lines between them. Select a file to see what
            it depends on and what depends on it.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-muted">
            <li className="flex items-center gap-2">
              <span className="h-0.5 w-4 rounded bg-incoming" aria-hidden="true" />
              Imported by
            </li>
            <li className="flex items-center gap-2">
              <span className="h-0.5 w-4 rounded bg-outgoing" aria-hidden="true" />
              Imports
            </li>
          </ul>
        </div>
        <MiniMap />
      </section>

      <section className="rounded-card bg-inverse p-6 text-inverse-fg">
        <h2 className="text-base font-semibold tracking-tight">Nothing on the map is guessed</h2>
        <p className="mt-2 text-sm leading-relaxed text-inverse-muted">
          A line exists only when the parser resolved a real import to a real file. Anything
          it couldn&apos;t resolve is listed with the reason, never drawn.
        </p>
      </section>
    </div>
  );
}
