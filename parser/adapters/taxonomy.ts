// The rail's categories per adapter: the role each adapter assigns and the
// name the rail shows for it. Imports nothing, so a browser component can read
// it without pulling a parser or a filesystem library into its bundle.
//
// Order is reading order and never changes: what a request reaches first,
// then the layers behind it, then plumbing.

export type RoleDef = { role: string; label: string };

const REACT = [
  { role: "component", label: "Components" },
  { role: "hook", label: "Hooks" },
] as const satisfies readonly RoleDef[];

const NEXTJS = [
  { role: "page", label: "Page routes" },
  { role: "api endpoint", label: "API endpoints" },
  { role: "server action", label: "Server actions" },
  { role: "layout", label: "Layouts" },
  { role: "error page", label: "Error pages" },
  { role: "loading state", label: "Loading states" },
  ...REACT,
  { role: "middleware", label: "Middleware & proxy" },
] as const satisfies readonly RoleDef[];

const NESTJS = [
  { role: "controller", label: "Controllers" },
  { role: "resolver", label: "Resolvers" },
  { role: "gateway", label: "Gateways" },
  { role: "service", label: "Services" },
  { role: "repository", label: "Repositories" },
  { role: "entity", label: "Entities" },
  { role: "schema", label: "Schemas" },
  { role: "dto", label: "DTOs" },
  { role: "module", label: "Modules" },
  { role: "guard", label: "Guards" },
  { role: "interceptor", label: "Interceptors" },
  { role: "pipe", label: "Pipes" },
  { role: "filter", label: "Filters" },
  { role: "middleware", label: "Middleware" },
] as const satisfies readonly RoleDef[];

const FASTAPI = [
  { role: "router", label: "Routers" },
  { role: "application", label: "Applications" },
  { role: "dependency", label: "Dependencies" },
  { role: "service", label: "Services" },
  { role: "crud", label: "CRUD" },
  { role: "schema", label: "Schemas" },
  { role: "model", label: "Models" },
  { role: "middleware", label: "Middleware" },
] as const satisfies readonly RoleDef[];

const FLASK = [
  { role: "blueprint", label: "Blueprints & views" },
  { role: "application", label: "Applications" },
  { role: "form", label: "Forms" },
  { role: "service", label: "Services" },
  { role: "schema", label: "Schemas" },
  { role: "model", label: "Models" },
] as const satisfies readonly RoleDef[];

const DJANGO = [
  { role: "urls", label: "URL configs" },
  { role: "view", label: "Views" },
  { role: "serializer", label: "Serializers" },
  { role: "form", label: "Forms" },
  { role: "model", label: "Models" },
  { role: "admin", label: "Admin" },
  { role: "signal", label: "Signals" },
  { role: "task", label: "Tasks" },
  { role: "middleware", label: "Middleware" },
  { role: "command", label: "Commands" },
  { role: "migration", label: "Migrations" },
  { role: "settings", label: "Settings" },
  { role: "app config", label: "App configs" },
] as const satisfies readonly RoleDef[];

const SPRING = [
  { role: "controller", label: "Controllers" },
  { role: "service", label: "Services" },
  { role: "repository", label: "Repositories" },
  { role: "entity", label: "Entities" },
  { role: "dto", label: "DTOs" },
  { role: "exception handler", label: "Exception handlers" },
  { role: "filter", label: "Filters" },
  { role: "configuration", label: "Configuration" },
  { role: "application", label: "Applications" },
] as const satisfies readonly RoleDef[];

const ASPNET = [
  { role: "controller", label: "Controllers" },
  { role: "endpoint", label: "Minimal API endpoints" },
  { role: "razor page", label: "Razor pages" },
  { role: "hub", label: "Hubs" },
  { role: "service", label: "Services" },
  { role: "repository", label: "Repositories" },
  { role: "model", label: "Models" },
  { role: "dto", label: "DTOs" },
  { role: "middleware", label: "Middleware" },
  { role: "startup", label: "Startup" },
] as const satisfies readonly RoleDef[];

// Go and Rust have no file-naming conventions of their own; these come from
// what registers routes, and from the folder names projects use.
const SERVER = [
  { role: "router", label: "Routers" },
  { role: "handler", label: "Handlers" },
  { role: "middleware", label: "Middleware" },
  { role: "service", label: "Services" },
  { role: "repository", label: "Repositories" },
  { role: "model", label: "Models" },
  { role: "command", label: "Commands" },
] as const satisfies readonly RoleDef[];

const RAILS = [
  { role: "routes", label: "Routes" },
  { role: "controller", label: "Controllers" },
  { role: "channel", label: "Channels" },
  { role: "view", label: "Views" },
  { role: "helper", label: "Helpers" },
  { role: "serializer", label: "Serializers" },
  { role: "model", label: "Models" },
  { role: "concern", label: "Concerns" },
  { role: "mailer", label: "Mailers" },
  { role: "job", label: "Jobs" },
  { role: "migration", label: "Migrations" },
  { role: "initializer", label: "Initializers" },
] as const satisfies readonly RoleDef[];

const LARAVEL = [
  { role: "routes", label: "Routes" },
  { role: "controller", label: "Controllers" },
  { role: "request", label: "Form requests" },
  { role: "resource", label: "API resources" },
  { role: "view", label: "Views" },
  { role: "model", label: "Models" },
  { role: "middleware", label: "Middleware" },
  { role: "policy", label: "Policies" },
  { role: "job", label: "Jobs" },
  { role: "event", label: "Events" },
  { role: "listener", label: "Listeners" },
  { role: "mail", label: "Mail" },
  { role: "notification", label: "Notifications" },
  { role: "command", label: "Console commands" },
  { role: "provider", label: "Providers" },
  { role: "migration", label: "Migrations" },
  { role: "seeder", label: "Seeders & factories" },
] as const satisfies readonly RoleDef[];

const SVELTEKIT = [
  { role: "page", label: "Pages" },
  { role: "endpoint", label: "Endpoints" },
  { role: "layout", label: "Layouts" },
  { role: "error page", label: "Error pages" },
  { role: "component", label: "Components" },
  { role: "hook", label: "Hooks" },
] as const satisfies readonly RoleDef[];

const NUXT = [
  { role: "page", label: "Pages" },
  { role: "api endpoint", label: "Server routes" },
  { role: "layout", label: "Layouts" },
  { role: "component", label: "Components" },
  { role: "composable", label: "Composables" },
  { role: "store", label: "Stores" },
  { role: "middleware", label: "Middleware" },
  { role: "plugin", label: "Plugins" },
] as const satisfies readonly RoleDef[];

const REMIX = [
  { role: "route", label: "Route modules" },
  { role: "resource route", label: "Resource routes" },
  { role: "layout", label: "Layouts" },
  ...REACT,
] as const satisfies readonly RoleDef[];

const ASTRO = [
  { role: "page", label: "Pages" },
  { role: "endpoint", label: "Endpoints" },
  { role: "layout", label: "Layouts" },
  { role: "component", label: "Components" },
  { role: "content", label: "Content" },
] as const satisfies readonly RoleDef[];

const ANGULAR = [
  { role: "component", label: "Components" },
  { role: "routing", label: "Routing" },
  { role: "service", label: "Services" },
  { role: "guard", label: "Guards" },
  { role: "resolver", label: "Resolvers" },
  { role: "interceptor", label: "Interceptors" },
  { role: "directive", label: "Directives" },
  { role: "pipe", label: "Pipes" },
  { role: "module", label: "Modules" },
  { role: "state", label: "State" },
] as const satisfies readonly RoleDef[];

const VUE = [
  { role: "view", label: "Views" },
  { role: "component", label: "Components" },
  { role: "composable", label: "Composables" },
  { role: "store", label: "Stores" },
  { role: "router", label: "Router" },
  { role: "plugin", label: "Plugins" },
] as const satisfies readonly RoleDef[];

// Node servers have no file conventions of their own: routers are the files
// that register routes; the rest by the folder names projects use.
const NODE_SERVER = [
  { role: "router", label: "Routers" },
  { role: "handler", label: "Handlers" },
  { role: "plugin", label: "Plugins" },
  { role: "middleware", label: "Middleware" },
  { role: "service", label: "Services" },
  { role: "model", label: "Models" },
] as const satisfies readonly RoleDef[];

const EXPRESS = [
  { role: "router", label: "Routers" },
  { role: "controller", label: "Controllers" },
  { role: "middleware", label: "Middleware" },
  { role: "validator", label: "Validators" },
  { role: "service", label: "Services" },
  { role: "model", label: "Models" },
  { role: "config", label: "Config" },
] as const satisfies readonly RoleDef[];

const PY_SERVER = [
  { role: "controller", label: "Controllers & handlers" },
  { role: "service", label: "Services" },
  { role: "schema", label: "Schemas" },
  { role: "model", label: "Models" },
  { role: "middleware", label: "Middleware" },
] as const satisfies readonly RoleDef[];

const JAXRS = [
  { role: "resource", label: "Resources" },
  ...SPRING.filter((r) => r.role !== "controller"),
] as const satisfies readonly RoleDef[];

const SYMFONY = [
  { role: "controller", label: "Controllers" },
  { role: "template", label: "Templates" },
  { role: "form", label: "Forms" },
  { role: "service", label: "Services" },
  { role: "repository", label: "Repositories" },
  { role: "entity", label: "Entities" },
  { role: "security", label: "Security" },
  { role: "listener", label: "Listeners & handlers" },
  { role: "command", label: "Commands" },
  { role: "migration", label: "Migrations" },
] as const satisfies readonly RoleDef[];

const PHOENIX = [
  { role: "router", label: "Router" },
  { role: "controller", label: "Controllers" },
  { role: "live view", label: "LiveViews" },
  { role: "channel", label: "Channels" },
  { role: "template", label: "Templates & HTML" },
  { role: "component", label: "Components" },
  { role: "migration", label: "Migrations" },
] as const satisfies readonly RoleDef[];

const VAPOR = [
  { role: "router", label: "Routes" },
  { role: "controller", label: "Controllers" },
  { role: "middleware", label: "Middleware" },
  { role: "dto", label: "DTOs" },
  { role: "model", label: "Models" },
  { role: "migration", label: "Migrations" },
] as const satisfies readonly RoleDef[];

type RoleOf<T extends readonly RoleDef[]> = T[number]["role"];
export type ReactRole = RoleOf<typeof REACT>;
export type NextjsRole = RoleOf<typeof NEXTJS>;
export type NestjsRole = RoleOf<typeof NESTJS>;
export type FastapiRole = RoleOf<typeof FASTAPI>;
export type FlaskRole = RoleOf<typeof FLASK>;
export type DjangoRole = RoleOf<typeof DJANGO>;
export type SpringRole = RoleOf<typeof SPRING>;
export type AspnetRole = RoleOf<typeof ASPNET>;
export type ServerRole = RoleOf<typeof SERVER>;
export type RailsRole = RoleOf<typeof RAILS>;
export type LaravelRole = RoleOf<typeof LARAVEL>;
export type ExpressRole = RoleOf<typeof EXPRESS>;

// Adapter name, how its users write it, and its rail. Detection order lives
// with the adapters; this is only names.
const FRAMEWORKS: readonly (readonly [string, string, readonly RoleDef[]])[] = [
  ["nextjs", "Next.js", NEXTJS],
  ["nestjs", "NestJS", NESTJS],
  ["sveltekit", "SvelteKit", SVELTEKIT],
  ["nuxt", "Nuxt", NUXT],
  ["remix", "Remix / React Router", REMIX],
  ["astro", "Astro", ASTRO],
  ["fastify", "Fastify", NODE_SERVER],
  ["hono", "Hono", NODE_SERVER],
  ["koa", "Koa", NODE_SERVER],
  ["express", "Express", EXPRESS],
  ["angular", "Angular", ANGULAR],
  ["vue", "Vue", VUE],
  ["react", "React", REACT],
  ["fastapi", "FastAPI", FASTAPI],
  ["litestar", "Litestar", PY_SERVER],
  ["starlette", "Starlette", PY_SERVER],
  ["django", "Django", DJANGO],
  ["flask", "Flask", FLASK],
  ["spring", "Spring Boot", SPRING],
  ["micronaut", "Micronaut", SPRING],
  ["jaxrs", "JAX-RS (Quarkus, Jakarta EE)", JAXRS],
  ["ktor", "Ktor", SERVER],
  ["aspnet", "ASP.NET Core", ASPNET],
  ["gin", "Gin", SERVER],
  ["echo", "Echo", SERVER],
  ["chi", "Chi", SERVER],
  ["fiber", "Fiber", SERVER],
  ["actix", "Actix Web", SERVER],
  ["axum", "Axum", SERVER],
  ["rocket", "Rocket", SERVER],
  ["rails", "Rails", RAILS],
  ["laravel", "Laravel", LARAVEL],
  ["symfony", "Symfony", SYMFONY],
  ["phoenix", "Phoenix", PHOENIX],
  ["vapor", "Vapor", VAPOR],
];

const BY_NAME = new Map(FRAMEWORKS.map(([name, label, roles]) => [name, { label, roles }]));

/** How a framework is written by the people who use it. Null for no framework. */
export function frameworkName(adapter: string): string | null {
  return BY_NAME.get(adapter)?.label ?? null;
}

/** The adapter's categories in rail order. None for an adapter with no roles. */
export function rolesFor(adapter: string): readonly RoleDef[] {
  return BY_NAME.get(adapter)?.roles ?? [];
}
