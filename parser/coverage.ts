import type { Coverage, ImportKind, ImportOutcome, ImportRecord, ReasonGroup, RepoFile } from "./types.ts";

// Pure tallies over files and imports. Every count here can be re-derived from
// the arrays in the result; nothing is estimated.

const EXAMPLES = 5;

export function coverageOf(files: readonly RepoFile[], imports: readonly ImportRecord[]): Coverage {
  const skipped = new Map<string, { count: number; examples: string[] }>();
  for (const f of files) {
    if (f.status !== "skipped" || !f.skipReason) continue;
    const entry = skipped.get(f.skipReason) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < EXAMPLES) entry.examples.push(f.path);
    skipped.set(f.skipReason, entry);
  }

  const outcomes: Record<ImportOutcome, number> = { resolved: 0, external: 0, excluded: 0, unresolved: 0 };
  const kinds = new Map<ImportKind, { seen: number; resolved: number }>();
  const reasons = new Map<string, ReasonGroup>();
  for (const imp of imports) {
    outcomes[imp.outcome]++;
    const k = kinds.get(imp.kind) ?? { seen: 0, resolved: 0 };
    k.seen++;
    if (imp.outcome === "resolved") k.resolved++;
    kinds.set(imp.kind, k);
    if (imp.outcome === "resolved") continue;
    const reason = imp.reason ?? "no reason recorded";
    const key = `${imp.outcome}\0${reason}`;
    const group = reasons.get(key) ?? { outcome: imp.outcome, reason, count: 0, examples: [] };
    group.count++;
    if (group.examples.length < EXAMPLES) group.examples.push({ from: imp.from, specifier: imp.specifier, line: imp.line });
    reasons.set(key, group);
  }

  return {
    filesFound: files.length,
    filesParsed: files.filter((f) => f.status === "parsed").length,
    filesSkipped: files.filter((f) => f.status === "skipped").length,
    skipped: [...skipped].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count),
    folders: new Set(files.map((f) => f.folder)).size,
    imports: outcomes,
    byKind: [...kinds].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.seen - a.seen),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
  };
}
