import { writeFileSync } from "node:fs";
import { parseRepository } from "./index.ts";
import { readParseResult } from "./read.ts";
import type { ParseResult } from "./types.ts";

// node parser/cli.ts <directory> [--out result.json]
// node parser/cli.ts --read result.json
//
// Prints what was found. --out writes the full typed result; --read loads one
// back through the validator and prints the same summary from it.

function summary(r: ParseResult): string {
  const c = r.coverage;
  const lines: string[] = [];
  const pad = (n: number) => String(n).padStart(7);
  lines.push(`${r.root}  (files from ${r.fileSource}, adapter: ${r.adapter})`, "");
  lines.push(`files found   ${pad(c.filesFound)}`);
  lines.push(`files parsed  ${pad(c.filesParsed)}`);
  lines.push(`files skipped ${pad(c.filesSkipped)}   (${c.filesParsed} + ${c.filesSkipped} = ${c.filesParsed + c.filesSkipped})`);
  for (const s of c.skipped) lines.push(`  ${pad(s.count)}  ${s.reason}   e.g. ${s.examples.slice(0, 2).join(", ")}`);
  const unfoldered = r.files.filter((f) => !f.folder).length;
  lines.push("", `folders       ${pad(c.folders)}   (files without a folder: ${unfoldered})`);

  const langs = new Map<string, number>();
  for (const f of r.files) if (f.status === "parsed") langs.set(f.language, (langs.get(f.language) ?? 0) + 1);
  lines.push(`parsed by language: ${[...langs].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ") || "none"}`);
  const errors = r.files.filter((f) => f.hadSyntaxErrors === true).length;
  if (errors) lines.push(`parsed with syntax-error recovery: ${errors}`);

  const total = c.imports.resolved + c.imports.external + c.imports.excluded + c.imports.unresolved;
  lines.push("", `imports seen  ${pad(total)}`);
  for (const o of ["resolved", "external", "excluded", "unresolved"] as const) lines.push(`  ${o.padEnd(11)} ${pad(c.imports[o])}`);
  lines.push("", "by kind (seen → resolved):");
  for (const k of c.byKind) lines.push(`  ${k.kind.padEnd(19)} ${pad(k.seen)} → ${k.resolved}`);

  const notResolved = c.reasons.filter((g) => g.outcome !== "external");
  if (notResolved.length) {
    lines.push("", "excluded and unresolved, by reason:");
    for (const g of notResolved) {
      lines.push(`  ${pad(g.count)}  [${g.outcome}] ${g.reason}`);
      for (const e of g.examples.slice(0, 3)) lines.push(`             ${e.from}:${e.line}  ${e.specifier}`);
    }
  }
  lines.push("", `edges ${r.edges.length}`);
  return lines.join("\n");
}

async function main(argv: string[]) {
  if (argv[0] === "--read") {
    if (!argv[1]) throw new Error("usage: --read <result.json>");
    const result = readParseResult(argv[1]);
    console.log(`read back ${argv[1]}: shape valid, ${result.files.length} files, ${result.edges.length} edges\n`);
    console.log(summary(result));
    return;
  }
  const dir = argv[0];
  if (!dir) throw new Error("usage: node parser/cli.ts <directory> [--out result.json] | --read <result.json>");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? null : argv[outIndex + 1];
  if (outIndex !== -1 && !out) throw new Error("--out needs a file path");

  const started = Date.now();
  const result = await parseRepository(dir);
  console.log(summary(result));
  console.log(`\nparsed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (out) {
    writeFileSync(out, JSON.stringify(result));
    console.log(`wrote ${out}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
