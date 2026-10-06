// node scripts/pane-counts.ts
//
// The phase 5 numbers: what the overview says, and for every file, that the
// pane's import and dependent lists agree with the parser's own fan counts.

import { describeFile, describeFolder, summarise } from "../lib/map/detail.ts";
import { fold } from "../lib/map/fold.ts";
import { fileEdges } from "../lib/map/view.ts";
import { preview as result } from "../lib/preview/data.ts";

const s = summarise(result);
console.log(`framework ${s.framework ?? "none"}, files ${s.files}, imports ${s.imports}, unidentified ${s.unidentified}`);
console.log(`leaned on ${s.leanedOn.length}: ${s.leanedOn.slice(0, 3).map((r) => `${r.path} (${r.count})`).join(", ")}`);
console.log(`nothing imports ${s.entryPoints.length}: ${s.entryPoints.slice(0, 3).map((r) => `${r.path} (${r.count})`).join(", ")}`);

const files = new Map(result.files.map((f) => [f.path, f]));
const edges = fileEdges(result.edges);
const fan = new Map(result.fan.map((f) => [f.path, f]));
let wrong = 0;
for (const f of result.files) {
  const d = describeFile(result, files, edges, f.path)!;
  const want = fan.get(f.path) ?? { fanIn: 0, fanOut: 0 };
  if (d.imports.length !== want.fanOut || d.importedBy.length !== want.fanIn) {
    wrong++;
    console.log(`  mismatch ${f.path}: pane ${d.imports.length}/${d.importedBy.length}, fan ${want.fanOut}/${want.fanIn}`);
  }
}
console.log(`files whose pane lists disagree with fan counts: ${wrong} of ${result.files.length}`);

const folded = fold(result.files);
let badFolder = 0;
for (const dir of folded.groups.keys()) {
  const d = describeFolder(folded, files, dir)!;
  if (d.kinds.reduce((n, k) => n + k.count, 0) !== d.files) badFolder++;
}
console.log(`folders whose kind counts don't add up: ${badFolder} of ${folded.groups.size}`);

if (wrong || badFolder) process.exit(1);
