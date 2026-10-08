// The model's prose, made renderable. It's asked for three pieces of
// formatting (inline code, bold and bullets) and those three are rendered.
// Anything else it adds anyway is taken apart rather than printed: a heading
// becomes its text, a link its label, and no backtick, asterisk or heading
// hash is ever left in what's shown.
//
// Every repository path in the prose becomes a path part, which the pane
// draws as a link that moves the map. Only paths that are really in the
// repository: anything else stays text.
//
// Pure, and safe for the browser.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; parts: Inline[] }
  | { t: "path"; v: string; kind: "file" | "folder" };

export type Block = { t: "p"; parts: Inline[] } | { t: "ul"; items: Inline[][] };

export type Known = { files: ReadonlySet<string>; folders: ReadonlySet<string> };

const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;

/** A path as written, if it's one of the repository's: trailing slash and punctuation ignored. */
function pathOf(token: string, known: Known): Inline | null {
  const bare = token.replace(/\/+$/, "");
  if (known.files.has(bare)) return { t: "path", v: bare, kind: "file" };
  if (known.folders.has(bare)) return { t: "path", v: bare, kind: "folder" };
  return null;
}

// Path-shaped runs of text: what a path in this repository can be made of.
const PATHISH = /[A-Za-z0-9_@.~+$\-[\]()/]+/g;

/** Plain text with any repository paths split out. Stray markup characters are dropped. */
function textParts(text: string, known: Known): Inline[] {
  const clean = text.replace(/[`*]/g, "");
  const out: Inline[] = [];
  let last = 0;
  for (const m of clean.matchAll(PATHISH)) {
    // Sentence punctuation and brackets around a path aren't part of it.
    const raw = m[0];
    const lead = raw.match(/^[([]+/)?.[0].length ?? 0;
    const core = raw.slice(lead).replace(/[.,;:!?)\]]+$/, "");
    if (!core.includes("/") && !core.includes(".")) continue;
    const path = pathOf(core, known);
    if (!path) continue;
    const start = m.index + lead;
    if (start > last) out.push({ t: "text", v: clean.slice(last, start) });
    out.push(path);
    last = start + core.length;
  }
  if (last < clean.length) out.push({ t: "text", v: clean.slice(last) });
  return out;
}

/** Inline code, bold and links; everything else as text. */
function inline(text: string, known: Known): Inline[] {
  // A link shows its label; where it points isn't the model's to decide.
  const unlinked = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const out: Inline[] = [];
  // Code spans first: what's inside them is literal, bold markers included.
  const pieces = unlinked.split(/(`+)([^`]+?)\1/);
  for (let i = 0; i < pieces.length; i++) {
    if (i % 3 === 1) continue; // the backtick run itself
    if (i % 3 === 2) {
      const code = pieces[i].trim();
      out.push(pathOf(code, known) ?? { t: "code", v: code });
      continue;
    }
    const bolded = pieces[i].split(/\*\*(.+?)\*\*|__(.+?)__/);
    for (let j = 0; j < bolded.length; j += 3) {
      out.push(...textParts(bolded[j], known));
      const inner = bolded[j + 1] ?? bolded[j + 2];
      if (inner !== undefined) out.push({ t: "bold", parts: textParts(inner, known) });
    }
  }
  return out.filter((p) => p.t !== "text" || p.v.length > 0);
}

export function renderProse(text: string, known: Known): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let items: string[] = [];
  const flushPara = () => {
    if (para.length > 0) blocks.push({ t: "p", parts: inline(para.join(" "), known) });
    para = [];
  };
  const flushList = () => {
    if (items.length > 0) blocks.push({ t: "ul", items: items.map((i) => inline(i, known)) });
    items = [];
  };

  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    // A heading keeps its words, as a bold line of its own, and loses its hashes.
    const heading = rawLine.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ t: "p", parts: [{ t: "bold", parts: inline(heading[1].replace(/\*\*/g, ""), known) }] });
      continue;
    }
    // A quote keeps its words and loses its marker.
    const line = rawLine.replace(/^\s*>\s?/, "");
    if (line.trim() === "" || RULE.test(line)) {
      flushPara();
      flushList();
    } else if (BULLET.test(line)) {
      flushPara();
      items.push(line.replace(BULLET, ""));
    } else if (items.length > 0 && /^\s+\S/.test(rawLine)) {
      // An indented line continues the bullet above it.
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
