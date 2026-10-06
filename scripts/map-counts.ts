// node scripts/map-counts.ts <repository folder>
//
// The phase 4 counts, read straight off the folding and view code the canvas
// uses, against a repository parsed on the spot.

import { fold } from "../lib/map/fold.ts";
import { buildView, fileEdges } from "../lib/map/view.ts";
import { parseRepository } from "../parser/index.ts";

// A repository folder in, parsed by the real parser: the same output the
// pipeline stores.
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/map-counts.ts <repository folder>");
  process.exit(1);
}
const result = await parseRepository(dir);

const folded = fold(result.files);
const edges = fileEdges(result.edges);
const fanIn = new Map(result.fan.map((f) => [f.path, f.fanIn]));
const view = buildView(folded, edges, fanIn, new Set());

const nodes = view.groups.length;
const files = result.files.length;
console.log(`files ${files}, folders ${result.coverage.folders}, threshold ${folded.threshold}`);
console.log(`1. nodes ${nodes}  (one per ${(files / nodes).toFixed(1)} files)`);

const single = view.groups.filter((g) => g.files.length < 2);
console.log(`2. nodes holding one file or fewer: ${single.length}${single.map((g) => `  ${g.dir}`).join("")}`);

const ids = new Set(view.groups.map((g) => g.dir));
const dangling = view.edges.filter((e) => !ids.has(e.source) || !ids.has(e.target));
console.log(`3. edges ${view.edges.length}, ending on a missing node: ${dangling.length}`);

const placed = [...folded.groupOf.keys()].length;
console.log(`   every file in exactly one node: ${placed === files ? "yes" : `no, ${placed} of ${files}`}`);

console.log("");
for (const g of view.groups) {
  console.log(`${String(g.files.length).padStart(4)} files  in ${String(g.fanIn).padStart(3)}  out ${String(g.fanOut).padStart(3)}  ${g.label}`);
}

// Open every folder at once, the worst case for row edges.
const all = buildView(folded, edges, fanIn, new Set(ids));
const rowKeys = new Map(all.groups.map((g) => [g.dir, new Set(g.rows.map((r) => r.path))]));
const badRow = all.edges.filter(
  (e) =>
    (e.sourceKey !== null && e.sourceKey !== "+more" && !rowKeys.get(e.source)!.has(e.sourceKey)) ||
    (e.targetKey !== null && e.targetKey !== "+more" && !rowKeys.get(e.target)!.has(e.targetKey)),
);
console.log(`\nall open: ${all.edges.length} edges, ending on a missing row: ${badRow.length}`);

if (single.length || dangling.length || badRow.length || placed !== files) process.exit(1);
