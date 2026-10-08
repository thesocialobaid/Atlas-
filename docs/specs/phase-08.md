# Phase 8 — Framework adapters

**Goal.** The application recognises what kind of codebase it's looking at,
across the frameworks the wider developer community actually uses.

## Build

- An adapter for Next.js — roles from path conventions, and routes derived from
  those same paths.
- An adapter for NestJS — roles from filename suffixes, and routes assembled
  from decorators on the controller and the method together.
- An adapter for React, which is nearly free once Next.js exists.
- Python: FastAPI, Flask and Django. Routes from decorators, blueprints and
  routers (FastAPI, Flask) or the URL configuration (Django), with prefixes
  followed across files through imports the parser resolved.
- Java: Spring Boot. Routes from the class mapping and the method mapping
  together.
- C#: ASP.NET Core. Routes from attribute routing on controllers and from
  minimal-API `Map*` calls.
- Go: Gin, Echo, Chi and Fiber. Routes from registration calls on routers and
  groups whose prefixes can be followed.
- Rust: Actix Web and Axum. Routes from Actix's attribute macros and scopes,
  and from Axum's router chains.
- Ruby: Rails. Routes from `config/routes.rb`, including resources, namespaces,
  scopes, and member and collection routes.
- PHP: Laravel. Routes from the route files, including resources, prefixes and
  groups.
- JavaScript servers: Fastify, Hono and Koa. Routes from registration calls,
  with prefixes from plugins, sub-apps and routers followed where they're
  written literally.
- File-routed JavaScript frameworks: SvelteKit, Nuxt, Remix / React Router
  (framework mode) and Astro. Routes from file positions, methods from the
  handlers a file exports or, for Nuxt, its file name.
- Angular and Vue: roles only. Their routing is client-side configuration,
  not server routes.
- Python, further: Litestar and Starlette, and Django REST Framework routers
  expanded by the actions their viewsets declare.
- Java, further: JAX-RS (Quarkus, Jakarta EE, Dropwizard) and Micronaut.
- PHP, further: Symfony, from `#[Route]` attributes.
- Rust, further: Rocket, from attribute macros and `mount()`.
- Kotlin: import edges in the parser (it becomes a parsed language), Ktor
  routes from its routing DSL, and Spring controllers written in Kotlin.
- Elixir: Phoenix, from its router DSL. Swift: Vapor, from route
  registration calls.
- Extracted routes, stored and shown as a table, each with the framework that
  declared it.
- The left rail reshaping itself per framework: a NestJS repository shows
  Controllers, Services, Modules, Entities. A Next.js one shows Page routes,
  API endpoints, Server actions.

## Constraints

- **Routes are exact or absent.** Emit a route only when the method and the
  full pattern are both recoverable from the parsed syntax with no inference.
  If either has to be guessed, show nothing. A wrong route pattern is the same
  failure as an invented edge. Anything seen but withheld is listed with its
  reason and counted.
- A framework's documented, fixed expansion counts as syntax: a Rails or
  Laravel resource is its seven routes, and a path segment is singularised by
  the framework's default rules. Where those rules can be overridden by the
  application, or the word falls outside the cases both frameworks agree on,
  the route is withheld.
- **Several frameworks can apply to one repository.** A framework is
  recognised by a package manifest that declares it, and it claims that
  package's directory. Each file belongs to the deepest directory claimed by a
  framework that reads its language; when two claim the same directory for the
  same files, the fixed detection order decides. A repository matching nothing
  still renders, with generic roles and an empty route table.
- A route reached through a router that's mounted somewhere this can't follow
  (computed prefix, passed in from a caller that can't be traced, never mounted
  at all) is withheld, never shown with a partial prefix.
- The rail taxonomy lives apart from the adapters themselves, so a browser
  component can read the list of category names without pulling a parser and a
  filesystem library into the bundle.
- Category names are the concrete role names, not abstractions. Someone reading
  a NestJS repository wants "Controllers 4", never "Entry points 4".
- Rail order is reading order and it stays fixed: frameworks in detection
  order, and within each, routable surfaces first, then the layers behind them,
  then plumbing. The same repository always presents its categories in the same
  places.

## Acceptance check

1. Analyse a Next.js repository: the rail says Page routes, API endpoints,
   Server actions, and the counts are right.
2. Analyse a NestJS repository: the rail says Controllers, Services, Modules,
   and the route table shows methods and full patterns.
3. Open three routes from that table and confirm by hand that the method and
   the path both match the code exactly.
4. Do the same for one repository each in Python, Java, Kotlin, C#, Go, Rust,
   Ruby, PHP, Elixir and Swift, and for one file-routed JavaScript framework: the rail shows that framework's roles, and three routes checked by hand
   match the code exactly. Every withheld route has a reason that's true.
5. Analyse a monorepo with two frameworks: the rail shows both, each under its
   own heading, and the route table says which framework each route came from.
6. Analyse something that matches no adapter — it renders, roles are generic,
   the route table is empty rather than wrong.
7. Search the parser core for the word "nextjs". It appears in the adapter and
   nowhere else.

## Not in this phase

AI classification of the files no adapter matched. They stay generic for now.
Express and `require()` (phase 9). Import edges for Ruby, PHP, Elixir and
Swift: their adapters read routes and roles, but those files' own imports
still aren't parsed. tRPC and GraphQL operations: they aren't URL routes.
