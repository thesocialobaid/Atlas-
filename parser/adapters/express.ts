import type { Adapter } from "../adapter.ts";
import type { ExpressRole } from "./taxonomy.ts";
import { conventionRole, isScript, packagesDepending } from "./shared.ts";

// Express gives files roles by the folders projects put them in, and reads no
// routes. Its routes are assembled at runtime from routers held in variables,
// mounted under prefixes and threaded through middleware chains; a route table
// that's only sometimes right is worse than an empty one.
//
// Singular and plural folder names both occur in real repositories.
const FOLDERS: readonly (readonly [ExpressRole, readonly string[]])[] = [
  ["router", ["routes", "route", "routers", "router"]],
  ["controller", ["controllers", "controller", "handlers", "handler"]],
  ["middleware", ["middlewares", "middleware"]],
  ["validator", ["validations", "validation", "validators", "validator"]],
  ["service", ["services", "service"]],
  ["model", ["models", "model"]],
  ["config", ["config", "configs"]],
];

export const express: Adapter = {
  name: "express",
  claims: (input) => packagesDepending(input, "express"),
  reads: isScript,
  analyze(scope) {
    const roles = new Map<string, string>();
    for (const f of scope.owned) {
      const role = conventionRole(f.path, FOLDERS);
      if (role) roles.set(f.path, role);
    }
    return { roles, routes: [], routesWithheld: [] };
  },
};
