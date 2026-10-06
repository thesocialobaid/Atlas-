// node scripts/insight-counts.ts
//
// The phase 6 numbers. First the insights over the checked-in repository,
// then the same functions over a small hand-made edge list whose answers are
// known, because the checked-in repository has no import cycle to find.

import { CATEGORIES, categoryOf } from "../lib/map/categories.ts";
import { fold } from "../lib/map/fold.ts";
import { cycles, insights, reach } from "../lib/map/graph.ts";
import { fileEdges } from "../lib/map/view.ts";
import { preview as result } from "../lib/preview/data.ts";

let failed = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed++;
};

const edges = fileEdges(result.edges);
const found = insights(result.files, edges);
console.log(`nothing imports ${found.unimported.length}: ${found.unimported.map((u) => u.path).join(", ")}`);
console.log(`imported by ${found.heavyCutoff}+ files: ${found.heavy.map((h) => `${h.path} (${h.importedBy})`).join(", ")}`);
console.log(`cycles ${found.cycles.length}: ${found.cycles.map((c) => c.join(" -> ")).join(" | ") || "none"}`);
console.log(`over 500 lines: ${found.long.map((l) => `${l.path} (${l.lines})`).join(", ")}`);

// Every listed cycle is a loop the edges really contain.
const has = new Set(edges.map((e) => `${e.from}\n${e.to}`));
const isLoop = (c: string[]) => c.every((p, i) => has.has(`${p}\n${c[(i + 1) % c.length]}`));
check("every cycle found in the repository is a real loop", found.cycles.every(isLoop));

const store = "src/state/store.ts";
const blast = reach(edges, store, "dependents");
const chain = reach(edges, store, "dependencies");
console.log(`\nblast radius of ${store}: ${blast.filter((r) => r.depth === 1).length} direct, ${blast.filter((r) => r.depth === 2).length} two steps away`);
console.log(`dependency chain of ${store}: ${chain.map((r) => `${r.path} (${r.depth})`).join(", ")}`);
const importers = new Set(edges.filter((e) => e.to === store).map((e) => e.from));
check("blast radius depth 1 is exactly the files that import it", blast.filter((r) => r.depth === 1).length === importers.size && blast.every((r) => r.depth !== 1 || importers.has(r.path)));

// Rail counts against what the panels would show with every folder open.
const folded = fold(result.files);
const railOk = CATEGORIES.every((c) => {
  const rail = result.files.filter((f) => categoryOf(f) === c).length;
  let panels = 0;
  for (const paths of folded.groups.values()) panels += paths.filter((p) => categoryOf(result.files.find((f) => f.path === p)!) === c).length;
  return rail === panels;
});
check("each category's panel matches add up to the rail's count", railOk);

// The planted graph: a -> b -> c -> a is a loop, d imports into it, e imports
// itself, f -> g is no loop at all.
console.log("\nplanted: a->b, b->c, c->a, d->a, e->e, f->g");
const e = (from: string, to: string) => ({ from, to, dynamic: false });
const planted = [e("a", "b"), e("b", "c"), e("c", "a"), e("d", "a"), e("e", "e"), e("f", "g")];
const plantedCycles = cycles(["a", "b", "c", "d", "e", "f", "g"], planted);
console.log(`cycles: ${plantedCycles.map((c) => c.join(" -> ")).join(" | ")}`);
check("finds the planted three-file loop", plantedCycles.some((c) => c.join() === "a,b,c"));
check("finds the file importing itself", plantedCycles.some((c) => c.join() === "e"));
check("finds nothing else", plantedCycles.length === 2);

const deep = Array.from({ length: 50_000 }, (_, i) => e(`n${i}`, `n${i + 1}`));
deep.push(e("n50000", "n0"));
const long = cycles(Array.from({ length: 50_001 }, (_, i) => `n${i}`), deep);
check("a 50,001-file loop doesn't overflow the stack", long.length === 1 && long[0].length === 50_001);

const blastD = reach(planted, "a", "dependents").map((r) => `${r.path}${r.depth}`).join();
check(`blast radius of a is c1,d1,b2 (got ${blastD})`, blastD === "c1,d1,b2");
const chainD = reach(planted, "d", "dependencies").map((r) => `${r.path}${r.depth}`).join();
check(`dependency chain of d is a1,b2 (got ${chainD})`, chainD === "a1,b2");

if (failed) process.exit(1);
