import { posix } from "node:path";
import { record, relJoin, verdict } from "../context.ts";
import type { Context, LanguageHandler, Source } from "../context.ts";
import type { ImportRecord } from "../types.ts";
import { lineOf, parserFor, unquote } from "./tree-sitter.ts";

// `#include "x.h"` is looked up next to the including file, which is the one
// location the language itself fixes. Further include directories come from
// the build system (-I flags), which isn't read, so a miss says exactly that.

export const c: LanguageHandler = {
  languages: ["c", "cpp"],

  async analyze(sources: Source[], ctx: Context): Promise<ImportRecord[]> {
    const parsers = { c: await parserFor("c"), cpp: await parserFor("cpp") };
    const out: ImportRecord[] = [];

    for (const { file, text } of sources) {
      const tree = (file.language === "cpp" ? parsers.cpp : parsers.c).parse(text);
      file.hadSyntaxErrors = tree.rootNode.hasError;
      const dir = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);

      for (const inc of tree.rootNode.descendantsOfType("preproc_include")) {
        const path = inc.childForFieldName("path");
        if (!path) continue;
        const line = lineOf(inc);
        if (path.type === "system_lib_string") {
          out.push(record.external(file.path, path.text, "include", line, "angle-bracket include: system or library header"));
          continue;
        }
        if (path.type !== "string_literal") {
          out.push(record.excluded(file.path, path.text, "include", line, "include through a macro; only a literal path can be read"));
          continue;
        }
        const spec = unquote(path.text);
        const candidate = relJoin(dir, spec);
        out.push(candidate === null
          ? record.unresolved(file.path, spec, "include", line, "path climbs above the repository root")
          : verdict(ctx, file.path, spec, "include", line, [candidate],
              "not found next to the including file; include directories set by the build system aren't known"));
      }
      tree.delete();
    }
    parsers.c.delete();
    parsers.cpp.delete();
    return out;
  },
};
