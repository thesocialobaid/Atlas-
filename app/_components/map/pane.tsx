"use client";

import { useState, type ReactNode } from "react";
import { CATEGORY_LABEL, type Category } from "@/lib/map/categories";
import type { FileDetail, FolderDetail, Ranked, Summary } from "@/lib/map/detail";
import { useHover } from "./state";

export type Tab = "structure" | "explanation";

/** Ranked lists show this many before offering the rest. */
const RANKED_ROWS = 10;

type Go = (path: string) => void;

type Props = {
  name: string;
  summary: Summary;
  file: FileDetail | null;
  folder: FolderDetail | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onGo: Go;
  onClear: () => void;
};

export function DetailPane({ name, summary, file, folder, tab, onTab, onGo, onClear }: Props) {
  if (!file && !folder) return <Overview name={name} summary={summary} onGo={onGo} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-stretch border-b border-border px-1">
        <div role="tablist" aria-label="Detail" className="flex flex-1 items-stretch">
          <TabButton id="structure" tab={tab} onTab={onTab}>
            Structure
          </TabButton>
          <TabButton id="explanation" tab={tab} onTab={onTab}>
            Explanation
          </TabButton>
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
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {file && (tab === "structure" ? <FileStructure detail={file} onGo={onGo} /> : <NoExplanation what="file" />)}
        {folder &&
          (tab === "structure" ? <FolderStructure detail={folder} /> : <NoExplanation what="folder" />)}
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
      aria-selected={active}
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

function Overview({ name, summary, onGo }: { name: string; summary: Summary; onGo: Go }) {
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
          <Fact label="Framework">{summary.framework ?? <span className="text-fg-muted">None detected</span>}</Fact>
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
            {summary.framework === null ? (
              <span className="text-fg-muted">Not recovered without a framework</span>
            ) : (
              <span className="text-fg-muted">None recovered</span>
            )}
          </Fact>
          <Fact label="Unidentified">
            <Num>{summary.unidentified}</Num>{" "}
            <span className="text-fg-muted">{summary.unidentified === 1 ? "file" : "files"} no convention recognised</span>
          </Fact>
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

function FileStructure({ detail, onGo }: { detail: FileDetail; onGo: Go }) {
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
          {file.role && <Fact label="Role">{file.role}</Fact>}
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
      </div>

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

function NoExplanation({ what }: { what: "file" | "folder" }) {
  return (
    <div className="px-3 py-6 text-xs">
      <p className="font-medium">No explanation yet</p>
      <p className="mt-1 leading-5 text-fg-muted">
        Nothing has been written for this {what}. Its structure, taken straight from the parser, is on the Structure
        tab.
      </p>
    </div>
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
