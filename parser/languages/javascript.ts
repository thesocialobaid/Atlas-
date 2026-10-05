import { builtinModules } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import { judgePath, readNode, record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportKind, ImportRecord } from "../types.ts";

const BUILTINS = new Set(builtinModules);

// Mapping files means following every import a .js file makes and every
// `import data from "./x.json"`, whatever the project's own settings say.
const FORCED: ts.CompilerOptions = { allowJs: true, resolveJsonModule: true };

const DEFAULTS: ts.CompilerOptions = {
  ...FORCED,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

const SOURCE_EXT = /\.(d\.)?([mc]?[jt]sx?)$/;

function toPosix(p: string) {
  return p.split(sep).join("/");
}

/** "app/page" for app/page.tsx, "lib" for lib/index.ts. */
function moduleName(path: string): string {
  const bare = path.replace(SOURCE_EXT, "");
  return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare === "index" ? "." : bare;
}

/** Package name a bare specifier refers to: "react", "@scope/pkg". */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Each file resolves with the nearest tsconfig.json above it, so a monorepo's
 * packages keep their own path aliases. Parsed once per config.
 */
function optionsFinder(root: string) {
  const byConfig = new Map<string, ts.CompilerOptions>();
  const byDir = new Map<string, ts.CompilerOptions>();
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  return (absFile: string): ts.CompilerOptions => {
    const dir = dirname(absFile);
    const cached = byDir.get(dir);
    if (cached) return cached;
    const found = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
    let options = DEFAULTS;
    if (found && !relative(root, found).startsWith("..")) {
      let parsed = byConfig.get(found);
      if (!parsed) {
        const cmd = ts.getParsedCommandLineOfConfigFile(found, {}, host);
        parsed = cmd ? { ...cmd.options, ...FORCED } : DEFAULTS;
        byConfig.set(found, parsed);
      }
      options = parsed;
    }
    byDir.set(dir, options);
    return options;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a tsconfig "paths" pattern claims this specifier. */
function matchesAlias(spec: string, options: ts.CompilerOptions): string | null {
  for (const pattern of Object.keys(options.paths ?? {})) {
    const star = pattern.indexOf("*");
    if (star === -1 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
      return pattern;
    }
  }
  return null;
}

/** Workspace packages declared anywhere in the repository, by name. */
function workspacePackages(ctx: Context): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of ctx.files.keys()) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    const text = readNode(ctx, path);
    if (text === null) continue;
    try {
      const pkg: unknown = JSON.parse(text);
      if (isRecord(pkg) && typeof pkg.name === "string") {
        map.set(pkg.name, dirname(path) === "." ? "" : toPosix(dirname(path)));
      }
    } catch {
      // A broken package.json declares nothing.
    }
  }
  return map;
}

/** Files a package.json names as its own entry, in the order bundlers try them. */
function declaredEntries(ctx: Context, dir: string): string[] {
  const text = readNode(ctx, dir ? `${dir}/package.json` : "package.json");
  if (!text) return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const rel = relJoin(dir, v);
    if (rel !== null) out.push(rel);
  };
  try {
    const pkg: unknown = JSON.parse(text);
    if (!isRecord(pkg)) return [];
    const exp = pkg.exports;
    const dot = isRecord(exp) && "." in exp ? exp["."] : exp;
    if (typeof dot === "string") add(dot);
    else if (isRecord(dot)) {
      for (const key of ["types", "import", "module", "default", "require"]) add(dot[key]);
    }
    for (const key of ["types", "typings", "module", "main"]) add(pkg[key]);
  } catch {
    return [];
  }
  return out;
}

export const javascript: LanguageHandler = {
  languages: ["typescript", "javascript"],

  analyze(sources: Source[], ctx: Context): ImportRecord[] {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    const optionsFor = optionsFinder(ctx.root);
    const cache = ts.createModuleResolutionCache(ctx.root, (s) => s);
    const workspaces = workspacePackages(ctx);
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      file.module = moduleName(file.path);
      const sf = project.createSourceFile(`/${file.path}`, text, { overwrite: true });
      const absFile = join(ctx.root, file.path);
      const options = optionsFor(absFile);

      const seen: { spec: string; kind: ImportKind; line: number }[] = [];
      for (const d of sf.getImportDeclarations()) {
        seen.push({ spec: d.getModuleSpecifierValue(), kind: "import", line: d.getStartLineNumber() });
      }
      for (const d of sf.getExportDeclarations()) {
        const spec = d.getModuleSpecifierValue();
        if (spec !== undefined) seen.push({ spec, kind: "re-export", line: d.getStartLineNumber() });
      }
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
        const arg = call.getArguments()[0];
        const line = call.getStartLineNumber();
        if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
          seen.push({ spec: arg.getLiteralValue(), kind: "dynamic", line });
        } else {
          out.push(
            record.excluded(file.path, arg ? arg.getText() : "", "dynamic", line,
              "dynamic import with a computed specifier; only literal strings can be read without running the code"),
          );
        }
      }
      project.removeSourceFile(sf);

      for (const { spec, kind, line } of seen) {
        out.push(resolve(ctx, file.path, absFile, spec, kind, line, options, cache, workspaces));
      }
    }
    return out;
  },
};

function resolve(
  ctx: Context,
  from: string,
  absFile: string,
  spec: string,
  kind: ImportKind,
  line: number,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
  workspaces: Map<string, string>,
): ImportRecord {
  if (spec.startsWith("node:") || BUILTINS.has(spec)) {
    return record.external(from, spec, kind, line, "Node.js built-in module");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return record.external(from, spec, kind, line, "URL import");
  }

  const result = ts.resolveModuleName(spec, absFile, options, ts.sys, cache).resolvedModule;
  if (result) {
    const rel = toPosix(relative(ctx.root, result.resolvedFileName));
    if (rel.startsWith("..")) return record.external(from, spec, kind, line, "resolves to a file outside the repository");
    if (rel.split("/").includes("node_modules")) {
      return record.external(from, spec, kind, line, `installed package "${packageName(spec)}"`);
    }
    return verdict(ctx, from, spec, kind, line, [rel], `resolved to ${rel}, which isn't in the repository`);
  }

  const relative_ = spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
  if (relative_ || spec.startsWith("/")) {
    // TypeScript only follows code and JSON; a stylesheet or an asset imported
    // by its exact path is still a real file.
    const literal = spec.startsWith("/")
      ? relJoin(spec.slice(1))
      : relJoin(toPosix(dirname(from)), spec);
    if (literal !== null && judgePath(ctx, literal) !== "missing") {
      return verdict(ctx, from, spec, kind, line, [literal], "");
    }
    return record.unresolved(from, spec, kind, line,
      spec.startsWith("/")
        ? "root-relative path with no file at that location in the repository"
        : `no file at ${literal ?? spec}, with or without a source extension or index file`);
  }

  const alias = matchesAlias(spec, options);
  if (alias !== null) {
    return record.unresolved(from, spec, kind, line, `matches tsconfig path alias "${alias}", but no file exists where it points`);
  }

  const name = packageName(spec);
  const workspaceDir = workspaces.get(name);
  if (workspaceDir !== undefined) {
    if (spec === name) {
      const entries = declaredEntries(ctx, workspaceDir);
      for (const entry of entries) {
        if (judgePath(ctx, entry) === "node") return record.resolved(from, spec, kind, line, [entry]);
      }
      return record.unresolved(from, spec, kind, line,
        `workspace package "${name}" isn't installed, and none of the entry files its package.json names exist in the repository (they're usually build output)`);
    }
    return record.unresolved(from, spec, kind, line,
      `subpath of workspace package "${name}"; without an install its exports map can't be followed`);
  }
  return record.external(from, spec, kind, line, `package "${name}" (not installed here, so not followed)`);
}
