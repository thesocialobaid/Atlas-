import type { Adapter, AdapterScope, FoundRoute } from "../adapter.ts";
import { HTTP_METHODS, type HttpMethod } from "../types.ts";
import { joinPaths, jvmClasses, propertiesPrefix, refs, strings, type Annotation, type JvmClass } from "./jvm.ts";
import { conventionRole, manifestsDeclaring, mentions, withheldList } from "./shared.ts";

// Annotation-routed JVM frameworks: a route is the class's path and the
// method's path together, the method from the method's annotation. Each
// reads Java and Kotlin alike. A server prefix from configuration sits in
// front of every route; when it can't be read as one plain value, every
// pattern is unknown and all are withheld.

const METHOD_NAMES = new Map(HTTP_METHODS.map((m) => [m as string, m]));

type Found = { methods: HttpMethod[]; paths: string[]; line: number } | { reason: string; line: number };

type Spec = {
  name: string;
  manifest: (text: string) => boolean;
  /** Classes this framework routes, and the paths at class level. Undefined: not a route class. */
  classPaths(cls: JvmClass): string[] | string | undefined;
  /** What one method annotation declares, if it's a routing one. */
  method(a: Annotation, all: readonly Annotation[]): Found | null;
  /** A prefix from configuration and code, in front of everything. */
  prefix(scope: AdapterScope, classes: readonly JvmClass[]): { value: string } | { reason: string; where: string };
  roles: readonly (readonly [string, RegExp])[];
  folders: readonly (readonly [string, readonly string[]])[];
  /** Files whose classes route requests, whatever they're named, get this role. */
  routeRole: string;
};

const pathsOf = (a: Annotation, ...keys: string[]): string[] | null => {
  for (const k of keys) if (a.named.has(k)) return strings(a.named.get(k));
  if (a.positional.length > 0) return strings(a.positional[0]);
  return [""];
};

function makeAdapter(spec: Spec): Adapter {
  return {
    name: spec.name,
    claims: (input) => manifestsDeclaring(input, (p) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(p), spec.manifest),
    reads: (path) => path.endsWith(".java") || path.endsWith(".kt"),

    async analyze(scope) {
      const w = withheldList();
      const found: FoundRoute[] = [];
      const routeFiles = new Set<string>();
      const { classes, broken } = await jvmClasses(scope, /@/);
      for (const b of broken) {
        const text = scope.read(b) ?? "";
        if (/@(Get|Post|Put|Patch|Delete|Request)Mapping|@Path\b|@(GET|POST|PUT|DELETE|PATCH)\b|@(Get|Post|Put|Patch|Delete)\(/.test(text)) {
          w.add("file has syntax the available grammar can't fully read, so its routes aren't trusted", b);
        }
      }

      for (const cls of classes) {
        const base = spec.classPaths(cls);
        if (base === undefined) continue;
        for (const m of cls.methods) {
          for (const a of m.annotations) {
            const r = spec.method(a, m.annotations);
            if (!r) continue;
            const where = `${cls.file}:${r.line}`;
            if (cls.interface) {
              w.add("route declared on an interface: which classes implement it isn't followed", where);
              continue;
            }
            if (typeof base === "string") {
              w.add(base, where);
              continue;
            }
            if ("reason" in r) {
              w.add(r.reason, where);
              continue;
            }
            for (const c of base) {
              for (const p of r.paths) {
                const path = joinPaths([c, p]);
                if (path === null) {
                  w.add("path is empty, or has a doubled or trailing slash; how the framework matches it isn't read here", where);
                  continue;
                }
                routeFiles.add(cls.file);
                for (const method of r.methods) found.push({ file: cls.file, method, path, line: r.line });
              }
            }
          }
        }
      }

      const prefix = spec.prefix(scope, classes);
      const routes: FoundRoute[] = [];
      const seen = new Set<string>();
      for (const r of found) {
        if ("reason" in prefix) {
          w.add(`no full pattern is known: ${prefix.reason} (${prefix.where})`, `${r.file}:${r.line}`);
          continue;
        }
        const path = prefix.value ? joinPaths([prefix.value, r.path]) : r.path;
        if (path === null) {
          w.add("the configured prefix has a trailing or doubled slash, which isn't read", `${r.file}:${r.line}`);
          continue;
        }
        const key = `${r.file}\n${r.method}\n${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          routes.push({ ...r, path });
        }
      }

      const roles = new Map<string, string>();
      for (const f of scope.owned) {
        const role = spec.roles.find(([, re]) => re.test(f.path))?.[0] ?? (routeFiles.has(f.path) ? spec.routeRole : conventionRole(f.path, spec.folders));
        if (role) roles.set(f.path, role);
      }
      return { roles, routes, routesWithheld: w.list() };
    },
  };
}

const JVM_FOLDERS: readonly (readonly [string, readonly string[]])[] = [
  ["entity", ["entity", "entities", "domain", "model", "models"]],
  ["dto", ["dto", "dtos"]],
];

const JVM_ROLES = (controller: RegExp, routeRole: string): readonly (readonly [string, RegExp])[] => [
  ["exception handler", /(ControllerAdvice|ExceptionHandler|ExceptionMapper|Advice)\.(java|kt)$/],
  [routeRole, controller],
  ["service", /(Service|ServiceImpl)\.(java|kt)$/],
  ["repository", /(Repository|Repo|Dao|DAO)\.(java|kt)$/],
  ["dto", /(Dto|DTO|Request|Response)\.(java|kt)$/],
  ["filter", /Filter\.(java|kt)$/],
  ["configuration", /(Config|Configuration)\.(java|kt)$/],
  ["application", /Application\.(java|kt)$/],
];

// ------------------------------------------------------------------ Spring

const SPRING_VERBS = new Map<string, HttpMethod>([
  ["GetMapping", "GET"], ["PostMapping", "POST"], ["PutMapping", "PUT"], ["PatchMapping", "PATCH"], ["DeleteMapping", "DELETE"],
]);

export const spring = makeAdapter({
  name: "spring",
  manifest: (t) => mentions(t, "spring-boot-starter-web") || mentions(t, "spring-webmvc") || mentions(t, "spring-webflux"),
  classPaths(cls) {
    const isController = cls.annotations.some((a) => a.name === "RestController" || a.name === "Controller");
    if (!isController && !cls.interface) return undefined;
    const mapping = cls.annotations.find((a) => a.name === "RequestMapping");
    if (!mapping) return [""];
    if (mapping.named.has("method")) return "the controller's @RequestMapping restricts methods, which isn't combined here";
    return pathsOf(mapping, "value", "path") ?? "the controller's @RequestMapping path isn't a plain string";
  },
  method(a) {
    const verb = SPRING_VERBS.get(a.name);
    if (!verb && a.name !== "RequestMapping") return null;
    let methods: HttpMethod[];
    if (verb) methods = [verb];
    else {
      if (!a.named.has("method")) return { reason: "@RequestMapping without method= answers every method", line: a.line };
      const names = refs(a.named.get("method"));
      const mapped = names?.map((n) => METHOD_NAMES.get(n));
      if (!mapped || mapped.some((m) => !m)) return { reason: "@RequestMapping's method isn't a plain RequestMethod", line: a.line };
      methods = mapped.filter((m): m is HttpMethod => m !== undefined);
    }
    const paths = pathsOf(a, "value", "path");
    return paths ? { methods, paths, line: a.line } : { reason: "mapping path isn't a plain string", line: a.line };
  },
  prefix: (scope) =>
    propertiesPrefix(
      scope,
      ["server.servlet.context-path", "server.servlet.contextPath", "spring.webflux.base-path", "spring.mvc.servlet.path"],
      /context-?path|contextPath|base-path|basePath|servlet:\s*\n\s+path/i,
    ),
  roles: JVM_ROLES(/Controller\.(java|kt)$/, "controller"),
  folders: JVM_FOLDERS,
  routeRole: "controller",
});

// ------------------------------------------------------------------ JAX-RS

const JAXRS_VERBS = new Map<string, HttpMethod>([
  ["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"], ["HEAD", "HEAD"], ["OPTIONS", "OPTIONS"],
]);

// Quarkus, Jakarta EE, Jersey, RESTEasy, Dropwizard and Helidon all route
// with the same JAX-RS annotations: @Path on the class and the method, and
// an HTTP method annotation. An @ApplicationPath, or Quarkus's root and REST
// paths, sit in front.
export const jaxrs = makeAdapter({
  name: "jaxrs",
  manifest: (t) =>
    ["quarkus-rest", "quarkus-resteasy", "jakarta.ws.rs", "javax.ws.rs", "jersey-server", "jersey-container", "resteasy", "dropwizard-core", "helidon-microprofile"].some((n) => mentions(t, n)),
  classPaths(cls) {
    const path = cls.annotations.find((a) => a.name === "Path");
    if (!path) return cls.methods.some((m) => m.annotations.some((a) => JAXRS_VERBS.has(a.name))) ? "class has no @Path: a sub-resource reached through a locator, which isn't followed" : undefined;
    return pathsOf(path, "value") ?? "the class's @Path isn't a plain string";
  },
  method(a, all) {
    const verb = JAXRS_VERBS.get(a.name);
    if (!verb) {
      // A method with @Path but no HTTP method is a sub-resource locator.
      if (a.name === "Path" && !all.some((x) => JAXRS_VERBS.has(x.name))) return { reason: "sub-resource locator: the routes are on the class it returns, which isn't followed", line: a.line };
      return null;
    }
    const path = all.find((x) => x.name === "Path");
    const paths = path ? pathsOf(path, "value") : [""];
    return paths ? { methods: [verb], paths, line: a.line } : { reason: "method's @Path isn't a plain string", line: a.line };
  },
  prefix(scope, classes) {
    const apps = classes.flatMap((c) => c.annotations.filter((a) => a.name === "ApplicationPath").map((a) => ({ a, file: c.file })));
    const values = new Set(apps.map(({ a }) => (a.positional[0]?.kind === "string" ? a.positional[0].value : null)));
    if (values.has(null)) return { reason: "@ApplicationPath isn't a plain string", where: apps[0].file };
    if (values.size > 1) return { reason: "more than one @ApplicationPath, and which resources each serves isn't read", where: apps[0].file };
    if (scope.files.some((f) => /(^|\/)WEB-INF\/web\.xml$/.test(f.path) && /url-pattern/.test(scope.read(f.path) ?? ""))) {
      return { reason: "web.xml maps the application to a URL pattern, which isn't read", where: "WEB-INF/web.xml" };
    }
    const root = propertiesPrefix(scope, ["quarkus.http.root-path"], /root-?path|rootPath|applicationContextPath/i);
    if ("reason" in root) return root;
    const rest = propertiesPrefix(scope, ["quarkus.rest.path", "quarkus.resteasy.path", "quarkus.resteasy-reactive.path"], /root-?path|rootPath/i);
    if ("reason" in rest) return rest;
    const app = values.size === 1 ? ([...values][0] ?? "") : "";
    const joined = joinPaths([root.value, rest.value, app]);
    return { value: joined === null || joined === "/" ? "" : joined };
  },
  roles: JVM_ROLES(/(Resource|Endpoint|Controller)\.(java|kt)$/, "resource"),
  folders: JVM_FOLDERS,
  routeRole: "resource",
});

// --------------------------------------------------------------- Micronaut

const MICRONAUT_VERBS = new Map<string, HttpMethod>([
  ["Get", "GET"], ["Post", "POST"], ["Put", "PUT"], ["Patch", "PATCH"], ["Delete", "DELETE"], ["Head", "HEAD"], ["Options", "OPTIONS"],
]);

export const micronaut = makeAdapter({
  name: "micronaut",
  manifest: (t) => mentions(t, "io.micronaut"),
  classPaths(cls) {
    const c = cls.annotations.find((a) => a.name === "Controller");
    if (!c) return undefined;
    // @Controller with no value is the root.
    return pathsOf(c, "value") ?? "the controller's path isn't a plain string";
  },
  method(a) {
    const verb = MICRONAUT_VERBS.get(a.name);
    if (!verb) return null;
    const paths = a.named.has("uris") ? strings(a.named.get("uris")) : pathsOf(a, "value", "uri");
    return paths ? { methods: [verb], paths: paths.map((p) => (p === "" ? "/" : p)), line: a.line } : { reason: "route path isn't a plain string", line: a.line };
  },
  prefix: (scope) => propertiesPrefix(scope, ["micronaut.server.context-path"], /context-path/i),
  roles: JVM_ROLES(/Controller\.(java|kt)$/, "controller"),
  folders: JVM_FOLDERS,
  routeRole: "controller",
});
