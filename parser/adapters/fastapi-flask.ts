import type { Adapter, AdapterScope } from "../adapter.ts";
import { readRouters, type RouterSpec } from "./python-routers.ts";
import { conventionRole, pythonDepending } from "./shared.ts";
import type { FastapiRole, FlaskRole } from "./taxonomy.ts";

const isPython = (path: string) => path.endsWith(".py");

// FastAPI joins by plain concatenation: include_router puts its prefix in
// front of each route's path, which already starts with the router's own.
// It refuses a prefix that ends in "/" or doesn't start with one.
const FASTAPI: RouterSpec = {
  module: "fastapi",
  pathKeyword: "path",
  apps: ["fastapi.FastAPI", "fastapi.applications.FastAPI"],
  routers: ["fastapi.APIRouter", "fastapi.routing.APIRouter"],
  ownPrefix: "prefix",
  prefixAt: "declaration",
  decorators: new Map([
    ["get", "GET"],
    ["post", "POST"],
    ["put", "PUT"],
    ["patch", "PATCH"],
    ["delete", "DELETE"],
    ["head", "HEAD"],
    ["options", "OPTIONS"],
    ["api_route", "keyword"],
  ]),
  addRoute: { name: "add_api_route", viewArg: { index: 1, keyword: "endpoint" } },
  mount: { name: "include_router", prefixKeyword: "prefix" },
  subApp: "mount",
  join: (prefix, path) => (prefix === "" ? path : prefix.startsWith("/") && !prefix.endsWith("/") ? prefix + path : null),
};

// Flask's own rule (BlueprintSetupState.add_url_rule): with no prefix the rule
// stands; otherwise one slash between them, and an empty rule is the prefix.
const FLASK: RouterSpec = {
  module: "flask",
  pathKeyword: "rule",
  apps: ["flask.Flask"],
  routers: ["flask.Blueprint"],
  ownPrefix: "url_prefix",
  prefixAt: "mount",
  decorators: new Map([
    ["route", "keyword"],
    ["get", "GET"],
    ["post", "POST"],
    ["put", "PUT"],
    ["patch", "PATCH"],
    ["delete", "DELETE"],
  ]),
  addRoute: { name: "add_url_rule", viewArg: { index: 2, keyword: "view_func" } },
  mount: { name: "register_blueprint", prefixKeyword: "url_prefix" },
  subApp: null,
  join: (prefix, rule) => (prefix === "" ? rule : rule ? `${prefix.replace(/\/+$/, "")}/${rule.replace(/^\/+/, "")}` : prefix),
};

const FASTAPI_FOLDERS: readonly (readonly [FastapiRole, readonly string[]])[] = [
  ["dependency", ["dependencies", "deps"]],
  ["service", ["services", "service"]],
  ["crud", ["crud"]],
  ["schema", ["schemas", "schema"]],
  ["model", ["models", "model"]],
  ["middleware", ["middleware", "middlewares"]],
];

const FLASK_FOLDERS: readonly (readonly [FlaskRole, readonly string[]])[] = [
  ["blueprint", ["views", "routes", "blueprints"]],
  ["form", ["forms"]],
  ["service", ["services"]],
  ["schema", ["schemas"]],
  ["model", ["models"]],
];

/** The file creating the app, then files declaring routes, whatever they're called; the rest go by folder and file name. */
async function analyze(scope: AdapterScope, spec: RouterSpec, routeRole: string, folders: readonly (readonly [string, readonly string[]])[]) {
  const found = await readRouters(scope, spec);
  const roles = new Map<string, string>();
  for (const f of scope.owned) {
    const role = found.appFiles.has(f.path) ? "application" : found.routeFiles.has(f.path) ? routeRole : conventionRole(f.path, folders);
    if (role) roles.set(f.path, role);
  }
  return { roles, routes: found.routes, routesWithheld: found.withheld };
}

export const fastapi: Adapter = {
  name: "fastapi",
  claims: (input) => pythonDepending(input, "fastapi"),
  reads: isPython,
  analyze: (scope) => analyze(scope, FASTAPI, "router", FASTAPI_FOLDERS),
};

export const flask: Adapter = {
  name: "flask",
  claims: (input) => pythonDepending(input, "flask"),
  reads: isPython,
  analyze: (scope) => analyze(scope, FLASK, "blueprint", FLASK_FOLDERS),
};
