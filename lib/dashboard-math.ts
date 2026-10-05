// Pure arithmetic over rows the server already fetched. No I/O.

const DAY = 86_400_000;

/** Count of timestamps per UTC day, oldest first, ending today. */
export function perDay(timestamps: string[], now: Date, days: number) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const buckets = Array.from({ length: days }, (_, i) => ({
    day: new Date(today - (days - 1 - i) * DAY).toISOString().slice(0, 10),
    count: 0,
  }));
  for (const ts of timestamps) {
    const index = days - 1 - Math.floor((today - Date.parse(ts.slice(0, 10))) / DAY);
    if (index >= 0 && index < days) buckets[index].count += 1;
  }
  return buckets;
}

export function seconds(start: string, end: string) {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
}

export function formatSeconds(total: number) {
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** "3 min ago", "6 h ago", "2 d ago" — coarse on purpose. */
export function ago(iso: string, now: Date) {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
