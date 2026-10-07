import type { Adapter } from "../adapter.ts";
import type { ReactRole } from "./taxonomy.ts";
import { baseName, isScript, packagesDepending } from "./shared.ts";

/**
 * React's conventions, by file name alone: a hook is named use-something, a
 * component is a JSX file. Shared with the Next.js adapter, which applies it
 * to whatever its own conventions don't claim.
 */
export function reactRoleOf(path: string): ReactRole | null {
  if (!isScript(path)) return null;
  if (/^use[A-Z0-9-]/.test(baseName(path))) return "hook";
  if (/\.[jt]sx$/.test(path)) return "component";
  return null;
}

// React routing is a library choice, not a file convention, so this adapter
// reads no routes.
export const react: Adapter = {
  name: "react",
  claims: (input) => packagesDepending(input, "react"),
  reads: isScript,
  analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = reactRoleOf(f.path);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes: [], routesWithheld: [] };
  },
};
