// The rail: every file in exactly one entry. Each framework's roles come
// first, frameworks in detection order and roles in their fixed order, shown
// even at zero so each sits in the same place every time. Files no role
// claimed fall into the generic kinds after them. Pure, and safe for the
// browser: the taxonomy imports nothing.

import { frameworkName, LABEL_FRAMEWORK, rolesFor } from "../../parser/adapters/taxonomy.ts";
import type { RepoFile } from "../../parser/types.ts";
import { CATEGORIES, CATEGORY_LABEL, categoryOf, type Category } from "./categories.ts";

export type RailEntry = {
  key: string;
  label: string;
  count: number;
  /** Generic kinds carry their map colour; roles have none, because a dozen hues would mean nothing. */
  swatch: Category | null;
};

export type RailGroup = {
  /** The framework's name; null for the generic kinds. */
  heading: string | null;
  entries: RailEntry[];
};

export type Rail = {
  groups: RailGroup[];
  /** Path to the key of the entry it's counted under. */
  entryOf: Map<string, string>;
};

const roleKey = (framework: string, role: string) => `role:${framework}:${role}`;

export function buildRail(
  adapters: readonly string[],
  files: readonly Pick<RepoFile, "path" | "language" | "role" | "framework">[],
): Rail {
  // Roles the model gave come after every framework's, under their own
  // heading, so a label is never mistaken for what a convention decided.
  const sources = files.some((f) => f.framework === LABEL_FRAMEWORK) ? [...adapters, LABEL_FRAMEWORK] : adapters;
  const known = new Set(sources.flatMap((a) => rolesFor(a).map((r) => roleKey(a, r.role))));
  const entryOf = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const f of files) {
    const role = f.role !== null && f.framework !== null ? roleKey(f.framework, f.role) : null;
    const key = role !== null && known.has(role) ? role : `kind:${categoryOf(f)}`;
    entryOf.set(f.path, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups: RailGroup[] = sources
    .filter((a) => rolesFor(a).length > 0)
    .map((a) => ({
      heading: frameworkName(a) ?? a,
      entries: rolesFor(a).map((r) => {
        const key = roleKey(a, r.role);
        return { key, label: r.label, count: counts.get(key) ?? 0, swatch: null };
      }),
    }));
  const kinds = CATEGORIES.filter((c) => counts.has(`kind:${c}`)).map((c) => ({
    key: `kind:${c}`,
    label: CATEGORY_LABEL[c],
    count: counts.get(`kind:${c}`)!,
    swatch: c,
  }));
  if (kinds.length > 0) groups.push({ heading: null, entries: kinds });
  return { groups, entryOf };
}
