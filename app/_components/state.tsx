// The one place an analysis state gets a colour. Blue is done, red has failed,
// grey is still waiting or working. Stale is a hollow ring: it isn't a state
// the row records, it's a run that stopped reporting and never will finish.
const STYLE: Record<string, { dot: string; label: string }> = {
  complete: { dot: "bg-accent", label: "Complete" },
  failed: { dot: "bg-danger", label: "Failed" },
  running: { dot: "bg-fg-muted", label: "Running" },
  queued: { dot: "bg-border", label: "Queued" },
  stale: { dot: "border border-fg-muted bg-transparent", label: "Stale" },
};

export function stateLabel(state: string) {
  return STYLE[state]?.label ?? state;
}

export function StateDot({ state, className = "" }: { state: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${STYLE[state]?.dot ?? "bg-border"} ${className}`}
    />
  );
}

export function StateBadge({ state }: { state: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <StateDot state={state} />
      {stateLabel(state)}
    </span>
  );
}
