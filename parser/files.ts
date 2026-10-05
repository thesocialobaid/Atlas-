import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { RepoFile, SkipReason } from "./types.ts";

const MAX_BYTES = 1024 * 1024;

// Extension → language. Anything not listed is named by its extension, so an
// unknown file is still a node with an honest label rather than "other".
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  css: "css", scss: "scss", sass: "sass", less: "less",
  html: "html", htm: "html",
  md: "markdown", mdx: "mdx",
  json: "json", jsonc: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  sh: "shell", bash: "shell", ps1: "powershell",
  rb: "ruby", php: "php", kt: "kotlin", swift: "swift", scala: "scala",
  vue: "vue", svelte: "svelte", sql: "sql", lua: "lua", dart: "dart",
};

const BY_NAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  "go.mod": "go-module",
  "go.sum": "go-sum",
};

export function languageOf(path: string): string {
  const name = posix.basename(path);
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  // A dotfile is named by itself: ".gitignore" is "gitignore".
  if (dot === 0) return name.slice(1).toLowerCase();
  if (dot < 0) return "none";
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? ext;
}

/**
 * The repository's files. Inside a git work tree this is what git tracks plus
 * untracked files that aren't ignored, so .gitignore decides and nothing is
 * second-guessed. Outside git, every file except .git and node_modules.
 */
export function listFiles(root: string): { paths: string[]; source: "git" | "walk" } {
  const inside = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (inside.status === 0 && inside.stdout.trim() === "true") {
    const listed = spawnSync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (listed.status !== 0) {
      throw new Error(`git ls-files failed in ${root}: ${listed.stderr.trim()}`);
    }
    const paths = listed.stdout
      .split("\0")
      .filter(Boolean)
      // Tracked files deleted from the working tree are listed but absent.
      .filter((p) => {
        try {
          return statSync(join(root, p)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    return { paths, source: "git" };
  }

  const paths: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) paths.push(child);
    }
  };
  walk("");
  return { paths: paths.sort(), source: "walk" };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}

export type LoadedFile = { file: RepoFile; text: string | null };

/** Reads, hashes and measures one file. Text is null when it can't be read as code. */
export function loadFile(root: string, path: string, parseable: (language: string) => boolean): LoadedFile {
  const bytes = readFileSync(join(root, path));
  const language = languageOf(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const folder = posix.dirname(path);

  let text: string | null = null;
  let skipReason: SkipReason | null = null;
  if (bytes.subarray(0, 8000).includes(0)) {
    skipReason = "binary file";
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      skipReason = "not valid UTF-8 text";
    }
  }
  const lines = text === null ? null : countLines(text);
  if (!skipReason && bytes.length > MAX_BYTES) skipReason = "larger than 1 MB";
  if (!skipReason && !parseable(language)) skipReason = `no import parser for ${language}`;

  return {
    file: {
      path,
      folder,
      language,
      lines,
      bytes: bytes.length,
      sha256,
      module: null,
      status: skipReason ? "skipped" : "parsed",
      skipReason,
      hadSyntaxErrors: null,
      role: null,
    },
    text: skipReason ? null : text,
  };
}
