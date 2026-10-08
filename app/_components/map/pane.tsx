"use client";

import { useState, type ReactNode } from "react";
import type { ExplainResult } from "@/app/map/[id]/actions";
import type { Freshness } from "@/lib/freshness";
import { CATEGORY_LABEL, type Category } from "@/lib/map/categories";
import { renderProse, type Inline, type Known } from "@/lib/map/prose";
import type { FileDetail, FolderDetail, Ranked, Summary } from "@/lib/map/detail";
import { INSIGHT_TEXT, LONG_LINES, REACH_DEPTH, type Direction, type Insights, type Reached } from "@/lib/map/graph";
import { frameworkName } from "@/parser/adapters/taxonomy";
import { useHover } from "./state";

export type Tab = "structure" | "explanation";

const TABS: { id: Tab; label: string }[] = [
  { id: "structure", label: "Structure" },
  { id: "explanation", label: "Explanation" },
];

/** Ranked lists show this many before offering the rest. */
const RANKED_ROWS = 10;

type Go = (path: string) => void;

/** One explanation's state. Freshness only for files: null for a folder, "checking" while GitHub is asked. */
export type Asked =
  | { status: "asking" }
  | { status: "failed"; message: string }
  | { status: "done"; answer: Extract<ExplainResult, { ok: true }>; freshness: Freshness | "checking" | null };

export type ExplanationProps = {
  /** The selection's explanation, if one was asked for. */
  asked: Asked | undefined;
  onExplain: () => void;
  known: Known;
  onGoFolder: (dir: string) => void;
  onReanalyse: () => void;
  reanalysing: boolean;
  reanalyseError: string | null;
};

/** Which walk is showing for the selected file, and what it found. */
export type ReachView = { direction: Direction | null; found: Reached[] | null };

type Props = {
  name: string;
  summary: Summary;
  insights: Insights;
  insightsOpen: boolean;
  onInsightsOpen: (open: boolean) => void;
  categories: ReadonlyMap<string, Category>;
  file: FileDetail | null;
  folder: FolderDetail | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  reach: ReachView;
  onReach: (direction: Direction | null) => void;
  onGo: Go;
  onClear: () => void;
  labelNote: string | null;
  explanation: ExplanationProps;
};

export function DetailPane(props: Props) {
  const { file, folder, tab, onTab, onGo, onClear } = props;
  if (!file && !folder) return <Overview {...props} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-stretch border-b border-border px-1">
        <div
          role="tablist"
          aria-label="Detail"
          className="flex flex-1 items-stretch"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const step = e.key === "ArrowRight" ? 1 : -1;
            const next = TABS[(TABS.findIndex((t) => t.id === tab) + step + TABS.length) % TABS.length].id;
            onTab(next);
            document.getElementById(`detail-tab-${next}`)?.focus();
          }}
        >
          {TABS.map((t) => (
            <TabButton key={t.id} id={t.id} tab={tab} onTab={onTab}>
              {t.label}
            </TabButton>
          ))}
        </div>
        <button
          type="button"
          onClick={onClear}
          title="Back to the overview (Esc)"
          aria-label="Back to the overview"
          className="my-2 flex w-7 items-center justify-center rounded-control text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        role="tabpanel"
        id="detail-panel"
        aria-labelledby={`detail-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {file &&
          (tab === "structure" ? (
            <FileStructure
              detail={file}
              reach={props.reach}
              onReach={props.onReach}
              categories={props.categories}
              onGo={onGo}
            />
          ) : (
            <Explanation what="file" detail={file} props={props.explanation} onGo={onGo} />
          ))}
        {folder &&
          (tab === "structure" ? (
            <FolderStructure detail={folder} />
          ) : (
            <Explanation what="folder" detail={folder} props={props.explanation} onGo={onGo} />
          ))}
      </div>
    </div>
  );
}

function TabButton({ id, tab, onTab, children }: { id: Tab; tab: Tab; onTab: (t: Tab) => void; children: ReactNode }) {
  const active = id === tab;
  return (
    <button
      type="button"
      role="tab"
      id={`detail-tab-${id}`}
      aria-selected={active}
      aria-controls="detail-panel"
      tabIndex={active ? 0 : -1}
      onClick={() => onTab(id)}
      className={`-mb-px border-b-2 px-2.5 text-xs font-medium ${
        active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Nothing selected: the repository as a whole. The pane's resting state.

function Overview({ name, summary, labelNote, insights, insightsOpen, onInsightsOpen, categories, onGo }: Props) {
  const { importsBy } = summary;
  const importParts = [
    [importsBy.resolved, "to a file in this repository"],
    [importsBy.external, "outside the repository"],
    [importsBy.excluded, "excluded"],
    [importsBy.unresolved, "unresolved"],
  ] as const;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
        <h2 className="truncate font-mono text-xs font-medium" title={name}>
          {name}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-3 text-xs">
          <Fact label={summary.frameworks.length > 1 ? "Frameworks" : "Framework"}>
            {summary.frameworks.length > 0 ? summary.frameworks.join(", ") : <span className="text-fg-muted">None detected</span>}
          </Fact>
          <Fact label="Files">
            <Num>{summary.files}</Num>
          </Fact>
          <Fact label="Imports">
            <Num>{summary.imports}</Num>
            <ul className="mt-0.5 text-[11px] leading-4 text-fg-muted">
              {importParts
                .filter(([n]) => n > 0)
                .map(([n, label]) => (
                  <li key={label}>
                    <Num>{n}</Num> {label}
                  </li>
                ))}
            </ul>
          </Fact>
          <Fact label="Routes">
            {/* Routes come only from a framework adapter. Without one there's
                nothing to count, and zero would claim there are none. */}
            {summary.frameworks.length === 0 ? (
              <span className="text-fg-muted">Not recovered without a framework</span>
            ) : summary.routesWithheld === null ? (
              <span className="text-fg-muted">Not read: analysed before routes were</span>
            ) : (
              <>
                <Num>{summary.routes}</Num>
                {summary.routesWithheld > 0 && (
                  <span className="text-fg-muted">
                    {" "}
                    · <Num>{summary.routesWithheld}</Num> not listed
                  </span>
                )}
              </>
            )}
          </Fact>
          <Fact label="Unidentified">
            <Num>{summary.unidentified}</Num>{" "}
            <span className="text-fg-muted">{summary.unidentified === 1 ? "file" : "files"} no convention recognised</span>
          </Fact>
          {labelNote && (
            <Fact label="Labels">
              <span className="text-fg-muted">{labelNote}</span>
            </Fact>
          )}
        </dl>

        <RankedList
          title="Leaned on most"
          note="Ordered by how many files import each one."
          unit="imported by"
          rows={summary.leanedOn}
          bar
          onGo={onGo}
        />
        <RankedList
          title="Where reading starts"
          note="Parsed files nothing imports, the ones that pull in most first."
          unit="imports"
          rows={summary.entryPoints}
          onGo={onGo}
        />
        <InsightsPanel
          insights={insights}
          framework={summary.frameworks[0] ?? null}
          open={insightsOpen}
          onOpen={onInsightsOpen}
          categories={categories}
          onGo={onGo}
        />
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Num({ children }: { children: number }) {
  return <span className="font-mono tabular-nums">{children.toLocaleString("en-US")}</span>;
}

function RankedList(props: {
  title: string;
  note: string;
  unit: string;
  rows: Ranked[];
  /** Draw each count as a share of the largest, in the incoming colour. */
  bar?: boolean;
  onGo: Go;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? props.rows : props.rows.slice(0, RANKED_ROWS);
  const max = props.rows[0]?.count ?? 0;
  return (
    <section className="border-t border-border py-2">
      <SectionHead title={props.title} count={props.rows.length} aside={props.unit} />
      <p className="px-3 pb-1 text-[11px] leading-4 text-fg-muted">{props.note}</p>
      {props.rows.length === 0 ? (
        <p className="px-3 py-1 text-xs text-fg-muted">None.</p>
      ) : (
        <ul>
          {shown.map((r) => (
            <PathRow key={r.path} path={r.path} category={r.category} onGo={props.onGo}>
              {props.bar && max > 0 && (
                <span aria-hidden="true" className="h-1 w-10 shrink-0 rounded-full bg-surface-2">
                  <span
                    className="block h-full rounded-full bg-incoming"
                    style={{ width: `${Math.max(6, (r.count / max) * 100)}%` }}
                  />
                </span>
              )}
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-muted">
                {r.count}
              </span>
            </PathRow>
          ))}
        </ul>
      )}
      {props.rows.length > RANKED_ROWS && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="mx-3 mt-1 text-[11px] text-fg-muted hover:text-fg"
        >
          {all ? "Show fewer" : `Show all ${props.rows.length}`}
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A file.

function FileStructure({
  detail,
  reach,
  onReach,
  categories,
  onGo,
}: {
  detail: FileDetail;
  reach: ReachView;
  onReach: (direction: Direction | null) => void;
  categories: ReadonlyMap<string, Category>;
  onGo: Go;
}) {
  const { file } = detail;
  return (
    <>
      <div className="px-3 pt-3 pb-2">
        <p className="flex items-start gap-2 font-mono text-xs leading-4 font-medium break-all">
          <Swatch category={detail.category} className="mt-1" />
          {file.path}
        </p>
        <dl className="mt-2.5 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <Fact label="Kind">
            {CATEGORY_LABEL[detail.category]} <span className="font-mono text-[11px] text-fg-muted">{file.language}</span>
          </Fact>
          {file.role && (
            <Fact label="Role">
              {file.role}
              {file.framework && <span className="text-fg-muted"> · {frameworkName(file.framework) ?? file.framework}</span>}
            </Fact>
          )}
          <Fact label="Length">
            {file.lines === null ? (
              <span className="text-fg-muted">Binary</span>
            ) : (
              <>
                <Num>{file.lines}</Num> {file.lines === 1 ? "line" : "lines"}
              </>
            )}
            <span className="text-fg-muted">, {formatBytes(file.bytes)}</span>
          </Fact>
          {file.status === "skipped" && (
            <Fact label="Imports">
              <span className="text-fg-muted">Not read: {file.skipReason}</span>
            </Fact>
          )}
          {file.hadSyntaxErrors && (
            <Fact label="Syntax">
              <span className="text-fg-muted">Parsed around syntax errors</span>
            </Fact>
          )}
        </dl>
        <div role="group" aria-label="Walk the imports" className="mt-3 grid grid-cols-2 gap-1.5">
          {WALKS.map((w) => (
            <button
              key={w.direction}
              type="button"
              aria-pressed={reach.direction === w.direction}
              title={w.hint}
              onClick={() => onReach(reach.direction === w.direction ? null : w.direction)}
              className={`h-7 rounded-control border text-xs font-medium ${
                reach.direction === w.direction
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border hover:bg-surface-2"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {reach.direction && reach.found && (
        <ReachList direction={reach.direction} found={reach.found} categories={categories} onGo={onGo} />
      )}

      <section className="border-t border-border py-2">
        <SectionHead title="Imports" count={detail.imports.length} tick="outgoing" />
        <NeighbourList rows={detail.imports} onGo={onGo} empty="Imports no file in this repository." />
        {(detail.external > 0 || detail.unresolved.length > 0) && (
          <div className="px-3 pt-1.5 text-[11px] leading-4 text-fg-muted">
            {detail.external > 0 && (
              <p>
                Also <Num>{detail.external}</Num> {detail.external === 1 ? "import" : "imports"} from outside the
                repository.
              </p>
            )}
            {detail.unresolved.length > 0 && (
              <>
                <p className="mt-1">Not tied to a file:</p>
                <ul>
                  {detail.unresolved.map((u) => (
                    <li key={`${u.line}:${u.specifier}`} className="mt-0.5">
                      <span className="font-mono text-fg">{u.specifier}</span>{" "}
                      <span className="font-mono">:{u.line}</span> {u.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      <section className="border-t border-border py-2">
        <SectionHead title="Imported by" count={detail.importedBy.length} tick="incoming" />
        <NeighbourList rows={detail.importedBy} onGo={onGo} empty="Nothing in this repository imports it." />
      </section>
    </>
  );
}

function NeighbourList({ rows, onGo, empty }: { rows: FileDetail["imports"]; onGo: Go; empty: string }) {
  if (rows.length === 0) return <p className="px-3 py-1 text-xs text-fg-muted">{empty}</p>;
  return (
    <ul>
      {rows.map((n) => (
        <PathRow key={n.path} path={n.path} category={n.category} onGo={onGo}>
          {n.dynamic && <span className="shrink-0 text-[10px] text-fg-muted">on demand</span>}
        </PathRow>
      ))}
    </ul>
  );
}

const WALKS: { direction: Direction; label: string; hint: string; tick: "incoming" | "outgoing" }[] = [
  {
    direction: "dependents",
    label: "Blast radius",
    hint: "Files that import this one, and the files that import those",
    tick: "incoming",
  },
  {
    direction: "dependencies",
    label: "Dependency chain",
    hint: "Files this one imports, and the files those import",
    tick: "outgoing",
  },
];

const DIRECT: Record<Direction, string> = { dependents: "Import it directly", dependencies: "Imported directly" };

/** Every level the walk returned, so the rows always add up to the count. */
const levels = Array.from({ length: REACH_DEPTH }, (_, i) => i + 1);

function ReachList({
  direction,
  found,
  categories,
  onGo,
}: {
  direction: Direction;
  found: Reached[];
  categories: ReadonlyMap<string, Category>;
  onGo: Go;
}) {
  const walk = WALKS.find((w) => w.direction === direction)!;
  return (
    <section className="border-t border-border py-2">
      <SectionHead title={walk.label} count={found.length} aside={`${REACH_DEPTH} levels`} tick={walk.tick} />
      {found.length === 0 ? (
        <p className="px-3 py-1 text-xs text-fg-muted">
          {direction === "dependents" ? "Nothing in this repository imports it." : "It imports no file in this repository."}
        </p>
      ) : (
        levels.map((depth) => {
          const level = found.filter((r) => r.depth === depth);
          if (level.length === 0) return null;
          const label = depth === 1 ? DIRECT[direction] : `${depth} steps away`;
          return (
            <div key={label} className="mt-1">
              <p className="px-3 pb-0.5 text-[11px] leading-4 text-fg-muted">
                {label} <Num>{level.length}</Num>
              </p>
              <ul>
                {level.map((r) => (
                  <PathRow key={r.path} path={r.path} category={categories.get(r.path) ?? "other"} onGo={onGo} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Insights. Facts about the edge list, behind a closed disclosure so they're
// never the first thing anyone reads: this explains a codebase, it doesn't
// grade one. The explanatory group leads; the ones that read closer to a
// verdict sit underneath.

function InsightsPanel({
  insights,
  framework,
  open,
  onOpen,
  categories,
  onGo,
}: {
  insights: Insights;
  framework: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  categories: ReadonlyMap<string, Category>;
  onGo: Go;
}) {
  const cat = (p: string) => categories.get(p) ?? "other";
  return (
    <section className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="insights"
        onClick={() => onOpen(!open)}
        className="flex h-8 w-full items-center gap-1.5 px-3 text-left text-xs font-medium hover:bg-surface-2"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={`shrink-0 text-fg-muted ${open ? "rotate-90" : ""}`}
        >
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Insights
      </button>
      {open && (
        <div id="insights" className="pb-2">
          <InsightGroup title="Nothing imports these" count={insights.unimported.length} text={INSIGHT_TEXT.unimported}>
            {framework === null && (
              <p className="px-3 pb-1 text-[11px] leading-4 text-fg-muted">
                No framework was detected, so files a framework or a script runner loads directly are listed too.
              </p>
            )}
            <CappedList
              rows={insights.unimported.map((u) => ({ path: u.path, value: u.imports }))}
              unit="imports"
              cat={cat}
              onGo={onGo}
            />
          </InsightGroup>

          <InsightGroup
            title={`Imported by ${insights.heavyCutoff} or more`}
            count={insights.heavy.length}
            text={INSIGHT_TEXT.heavy}
          >
            <CappedList
              rows={insights.heavy.map((h) => ({ path: h.path, value: h.importedBy }))}
              unit="imported by"
              cat={cat}
              onGo={onGo}
            />
          </InsightGroup>

          <InsightGroup title="Import loops" count={insights.cycles.length} text={INSIGHT_TEXT.cycle}>
            {insights.cycles.length === 0 ? (
              <p className="px-3 py-1 text-xs text-fg-muted">No file imports itself, directly or through others.</p>
            ) : (
              insights.cycles.map((loop) => (
                <div key={loop.join("\n")} className="mb-1.5">
                  {/* A real sequence: each file imports the next, and the last
                      imports the first. */}
                  <ol>
                    {loop.map((p) => (
                      <PathRow key={p} path={p} category={cat(p)} onGo={onGo} />
                    ))}
                  </ol>
                  <p className="px-3 text-[11px] leading-4 text-fg-muted">
                    which imports <span className="font-mono">{loop[0].slice(loop[0].lastIndexOf("/") + 1)}</span> again
                  </p>
                </div>
              ))
            )}
          </InsightGroup>

          <InsightGroup title={`Over ${LONG_LINES} lines`} count={insights.long.length} text={INSIGHT_TEXT.long}>
            <CappedList
              rows={insights.long.map((l) => ({ path: l.path, value: l.lines }))}
              unit="lines"
              cat={cat}
              onGo={onGo}
            />
          </InsightGroup>
        </div>
      )}
    </section>
  );
}

function InsightGroup({
  title,
  count,
  text,
  children,
}: {
  title: string;
  count: number;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="pt-1.5">
      <SectionHead title={title} count={count} />
      <p className="px-3 pb-1 text-[11px] leading-4 text-fg-muted">{text}</p>
      {children}
    </div>
  );
}

function CappedList({
  rows,
  unit,
  cat,
  onGo,
}: {
  rows: { path: string; value: number }[];
  unit: string;
  cat: (path: string) => Category;
  onGo: Go;
}) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <p className="px-3 py-1 text-xs text-fg-muted">None.</p>;
  const shown = all ? rows : rows.slice(0, RANKED_ROWS);
  return (
    <>
      <ul>
        {shown.map((r) => (
          <PathRow key={r.path} path={r.path} category={cat(r.path)} onGo={onGo}>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-muted" title={unit}>
              {r.value}
            </span>
          </PathRow>
        ))}
      </ul>
      {rows.length > RANKED_ROWS && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          className="mx-3 mt-1 text-[11px] text-fg-muted hover:text-fg"
        >
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// A folder.

function FolderStructure({ detail }: { detail: FolderDetail }) {
  const max = Math.max(...detail.kinds.map((k) => k.count));
  return (
    <>
      <div className="px-3 pt-3 pb-2">
        <p className="font-mono text-xs leading-4 font-medium break-all">
          {detail.dir === "." ? "Repository root" : `${detail.dir}/`}
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          <Num>{detail.files}</Num> {detail.files === 1 ? "file" : "files"}
        </p>
      </div>
      <section className="border-t border-border py-2">
        <SectionHead title="Kinds of file" count={detail.kinds.length} />
        <ul>
          {detail.kinds.map((k) => (
            <li key={k.category} className="flex h-6 items-center gap-2 px-3 text-xs">
              <Swatch category={k.category} />
              <span className="flex-1">{CATEGORY_LABEL[k.category]}</span>
              <span aria-hidden="true" className="h-1 w-16 shrink-0 rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(k.count / max) * 100}%`, background: `var(--cat-${k.category})` }}
                />
              </span>
              <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-muted">
                {k.count}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Explanation({
  what,
  detail,
  props,
  onGo,
}: {
  what: "file" | "folder";
  detail: FileDetail | FolderDetail;
  props: ExplanationProps;
  onGo: Go;
}) {
  const { asked } = props;
  const asking = asked?.status === "asking";
  const title = "file" in detail ? detail.file.path : detail.dir === "." ? "Repository root" : `${detail.dir}/`;
  return (
    <div className="px-3 pt-3 pb-4 text-xs">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 font-mono leading-4 font-medium break-all">{title}</p>
        <button
          type="button"
          onClick={props.onExplain}
          disabled={asking}
          className="h-6 shrink-0 rounded-control border border-border px-2 font-medium hover:bg-surface-2 disabled:text-fg-muted"
        >
          {asked?.status === "done" || asked?.status === "failed" ? "Explain again" : "Explain"}
        </button>
      </div>

      {asked === undefined && (
        <p className="mt-2 leading-5 text-fg-muted">
          {what === "file"
            ? "Written by the model from this file's source and the files it imports and is imported by, exactly as the parser found them."
            : "Written by the model from every file in this folder and every import that crosses its edge, exactly as the parser found them."}
        </p>
      )}
      {asking && <p className="mt-2 text-fg-muted">Asking the model…</p>}
      {asked?.status === "failed" && (
        <p role="alert" className="mt-2 leading-5 text-danger">
          {asked.message}
        </p>
      )}
      {asked?.status === "done" && (
        <>
          <Prose text={asked.answer.body} known={props.known} onGo={onGo} onGoFolder={props.onGoFolder} />
          <p className="mt-3 text-[11px] leading-4 text-fg-muted">
            {asked.answer.cached ? "From the cache" : "Written just now"} ·{" "}
            <span className="font-mono">{asked.answer.model}</span>
            {asked.answer.untraced && <> · Not traced: {asked.answer.untraced}</>}
          </p>
          {asked.freshness !== null && <FreshnessNote freshness={asked.freshness} props={props} />}
        </>
      )}
    </div>
  );
}

const STALE_TEXT = {
  changed: "This file has changed since it was analysed, so this explanation is stale.",
  gone: "This file is no longer on the default branch, so this explanation is stale.",
  moved: "The repository has moved past the analysed commit. This file is unchanged.",
} as const;

function FreshnessNote({ freshness, props }: { freshness: Freshness | "checking"; props: ExplanationProps }) {
  if (freshness === "checking") return <p className="mt-1 text-[11px] text-fg-muted">Checking GitHub for changes…</p>;
  if (freshness.state === "current") {
    return <p className="mt-1 text-[11px] text-fg-muted">The repository is still at the analysed commit.</p>;
  }
  if (freshness.state === "unknown") {
    return (
      <p className="mt-1 text-[11px] leading-4 text-fg-muted">Couldn&apos;t check GitHub for changes: {freshness.reason}</p>
    );
  }
  return (
    <div className="mt-2 rounded-control border border-border px-2.5 py-2">
      <p className="leading-5">{STALE_TEXT[freshness.state]}</p>
      <p className="font-mono text-[11px] text-fg-muted">now at {freshness.head.slice(0, 7)}</p>
      <button
        type="button"
        onClick={props.onReanalyse}
        disabled={props.reanalysing}
        className="mt-1.5 h-6 rounded-control border border-border px-2 font-medium hover:bg-surface-2 disabled:text-fg-muted"
      >
        {props.reanalysing ? "Starting…" : "Re-analyse"}
      </button>
      {props.reanalyseError && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {props.reanalyseError}
        </p>
      )}
    </div>
  );
}

/** The model's prose: paragraphs, bullets, inline code and bold, with every repository path a link. */
function Prose({ text, known, onGo, onGoFolder }: { text: string; known: Known; onGo: Go; onGoFolder: Go }) {
  const blocks = renderProse(text, known);
  const parts = (list: Inline[]): ReactNode =>
    list.map((p, i) => {
      if (p.t === "text") return <span key={i}>{p.v}</span>;
      if (p.t === "code") {
        return (
          <code key={i} className="rounded-[3px] bg-surface-2 px-1 font-mono text-[11px]">
            {p.v}
          </code>
        );
      }
      if (p.t === "bold") {
        return (
          <strong key={i} className="font-semibold">
            {parts(p.parts)}
          </strong>
        );
      }
      return <PathLink key={i} path={p.v} onGo={p.kind === "file" ? onGo : onGoFolder} folder={p.kind === "folder"} />;
    });
  return (
    <div className="mt-2 space-y-2 leading-5">
      {blocks.map((b, i) =>
        b.t === "p" ? (
          <p key={i}>{parts(b.parts)}</p>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-4 marker:text-fg-muted">
            {b.items.map((item, j) => (
              <li key={j}>{parts(item)}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** A path in prose that moves the map, and lights its file on the map when hovered. */
function PathLink({ path, onGo, folder }: { path: string; onGo: Go; folder: boolean }) {
  const { setHover } = useHover();
  return (
    <button
      type="button"
      onClick={() => onGo(path)}
      onMouseEnter={folder ? undefined : () => setHover({ from: "pane", paths: new Set([path]) })}
      onMouseLeave={folder ? undefined : () => setHover(null)}
      title={folder ? `Select the folder ${path}/` : `Select ${path}`}
      className="font-mono text-[11px] break-all text-accent hover:underline"
    >
      {folder ? `${path}/` : path}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces.

function SectionHead({
  title,
  count,
  aside,
  tick,
}: {
  title: string;
  count: number;
  aside?: string;
  /** Direction colour, matching the edges and row bars on the map. */
  tick?: "incoming" | "outgoing";
}) {
  return (
    <h3 className="flex h-6 items-center gap-2 px-3 text-xs font-medium">
      {tick && (
        <span
          aria-hidden="true"
          className={`h-3 w-0.5 rounded-full ${tick === "incoming" ? "bg-incoming" : "bg-outgoing"}`}
        />
      )}
      <span>{title}</span>
      <span className="font-mono text-[11px] font-normal tabular-nums text-fg-muted">{count}</span>
      {aside && <span className="ml-auto text-[11px] font-normal text-fg-muted">{aside}</span>}
    </h3>
  );
}

/**
 * A file path that moves the map's selection when clicked and lights its file
 * on the map when hovered. File name first, folder after it in grey, so the
 * part that tells files apart survives truncation.
 */
function PathRow({
  path,
  category,
  onGo,
  children,
}: {
  path: string;
  category: Category;
  onGo: Go;
  children?: ReactNode;
}) {
  const { hover, setHover } = useHover();
  const pointed = hover?.from === "map" && hover.paths.has(path);
  const cut = path.lastIndexOf("/");
  const base = path.slice(cut + 1);
  const dir = cut === -1 ? "" : path.slice(0, cut);
  return (
    <li>
      <button
        type="button"
        title={path}
        onClick={() => onGo(path)}
        onMouseEnter={() => setHover({ from: "pane", paths: new Set([path]) })}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover({ from: "pane", paths: new Set([path]) })}
        onBlur={() => setHover(null)}
        className={`flex h-[22px] w-full items-center gap-2 px-3 text-left hover:bg-surface-2 ${
          pointed ? "bg-surface-2" : ""
        }`}
      >
        <Swatch category={category} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono text-[11px]">
          <span className="shrink-0">{base}</span>
          {dir && <span className="truncate text-fg-muted">{dir}</span>}
        </span>
        {children}
      </button>
    </li>
  );
}

function Swatch({ category, className = "" }: { category: Category; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-[1px] ${className}`}
      style={{ background: `var(--cat-${category})` }}
    />
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
