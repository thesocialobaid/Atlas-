// Shown while the dashboard's data is on its way, including right after
// switching organization. Static blocks in the page's own shape, so nothing
// jumps when the real content lands, and nothing pulses while you wait.
function Block({ className }: { className: string }) {
  return <div className={`rounded-card border border-border bg-surface ${className}`} />;
}

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the dashboard</span>
      <div className="pl-12 md:pl-0">
        <div className="h-3 w-40 rounded bg-surface-2" />
        <div className="mt-3 h-7 w-44 rounded bg-surface-2" />
      </div>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Block className="h-[132px]" />
        <Block className="h-[132px]" />
        <Block className="h-[132px]" />
        <Block className="h-[132px]" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Block className="h-48" />
        <Block className="h-48" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Block className="h-72" />
        <Block className="h-72" />
      </div>
    </div>
  );
}
