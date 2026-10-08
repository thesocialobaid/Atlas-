// The output contract. Everything built after the parser reads this shape, so
// changing it means bumping OUTPUT_VERSION and updating every reader.

export const OUTPUT_VERSION = 3;

/** Why a file's imports weren't read. Every file is still a node. */
export type SkipReason =
  | "binary file"
  | "larger than 1 MB"
  | "not valid UTF-8 text"
  | `no import parser for ${string}`;

export type RepoFile = {
  /** POSIX path relative to the repository root. */
  path: string;
  /** Directory the file sits in, "." for the root. Everything groups by this. */
  folder: string;
  /** Detected from the file name, e.g. "typescript", "python", "json", "png". */
  language: string;
  /** Null for binary files. */
  lines: number | null;
  bytes: number;
  sha256: string;
  /**
   * The name other code uses to import this file, in its language's own terms:
   * "app/page" for TS, "pkg.mod" for Python, "a.b.C" for Java. Null when the
   * language has no such notion or the file declares none.
   */
  module: string | null;
  status: "parsed" | "skipped";
  skipReason: SkipReason | null;
  /**
   * True when the parser recovered from syntax errors in this file. Null when
   * the file wasn't parsed or its parser doesn't report recovery.
   */
  hadSyntaxErrors: boolean | null;
  /** Set by a framework adapter. Null when no adapter recognised the file. */
  role: string | null;
  /** The adapter that set the role; null exactly when role is. */
  framework: string | null;
};

export type ImportKind =
  | "import"
  | "re-export"
  | "dynamic"
  | "include"
  | "module-declaration"
  | "reference"
  /** A CommonJS require() with a literal specifier, or TypeScript's `import x = require()`. */
  | "require";

export type ImportOutcome =
  /** Points at a file that is a node in this result. */
  | "resolved"
  /** Points outside the repository: a package, the standard library, a URL. */
  | "external"
  /** Seen, and deliberately not turned into an edge, with the reason. */
  | "excluded"
  /** Should point at a repository file, and couldn't be tied to one. */
  | "unresolved";

export type ImportRecord = {
  from: string;
  /** Exactly as written in the source. */
  specifier: string;
  kind: ImportKind;
  line: number;
  outcome: ImportOutcome;
  /** Every file it resolved to. Usually one; a Go package can be several. */
  to: string[];
  /** Always set unless outcome is "resolved". */
  reason: string | null;
};

export type Edge = { from: string; to: string; kind: ImportKind };

/**
 * The names a JavaScript or TypeScript module exports, ESM and CommonJS alike.
 * Names is null, with the reason, when any export can't be named from the
 * file's own syntax; a partial list is never given.
 */
export type ModuleExports = {
  file: string;
  names: string[] | null;
  /** Set exactly when names is null. */
  reason: string | null;
};

export type FanCounts = { path: string; fanIn: number; fanOut: number };

export type ReasonGroup = {
  outcome: Exclude<ImportOutcome, "resolved">;
  reason: string;
  count: number;
  /** Up to five, so a failure can be found and read, not just counted. */
  examples: { from: string; specifier: string; line: number }[];
};

export type Coverage = {
  filesFound: number;
  filesParsed: number;
  filesSkipped: number;
  skipped: { reason: string; count: number; examples: string[] }[];
  folders: number;
  imports: Record<ImportOutcome, number>;
  /** Per kind, how many were seen and how many resolved. */
  byKind: { kind: ImportKind; seen: number; resolved: number }[];
  reasons: ReasonGroup[];
};

/** The methods a route can carry: the ones both frameworks name with their own syntax. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * A route an adapter read from syntax: the method and the full pattern, both
 * exactly as the framework will match them. Never partial, never guessed.
 */
export type Route = {
  /** The adapter that read it. */
  framework: string;
  file: string;
  method: HttpMethod;
  /** Starts with "/". Dynamic segments in the framework's own notation. */
  path: string;
  /** Where the route is declared: the method's decorator or export. */
  line: number;
};

/** Routes an adapter could see but not read exactly, grouped by why. */
export type Withheld = {
  framework: string;
  reason: string;
  count: number;
  /** "file:line", up to five. */
  examples: string[];
};

export type ParseResult = {
  version: typeof OUTPUT_VERSION;
  root: string;
  generatedAt: string;
  /** How the file list was built: from git (honours .gitignore) or a walk. */
  fileSource: "git" | "walk";
  /** Adapters that own at least one file, in detection order. Empty when none matched. */
  adapters: string[];
  files: RepoFile[];
  imports: ImportRecord[];
  /** Deduplicated: one per (from, to, kind). */
  edges: Edge[];
  /** Computed from edges after collapsing kinds, so two kinds count once. */
  fan: FanCounts[];
  /** One per parsed JavaScript or TypeScript file. */
  exports: ModuleExports[];
  coverage: Coverage;
  routes: Route[];
  routesWithheld: Withheld[];
};
