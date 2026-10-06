-- Storage for what the parser produces. Each column mirrors a field of the
-- parser's output contract (parser/types.ts); nothing here is derived, so the
-- stored rows say exactly what the parser said.
--
-- Rows are written by the pipeline, server-side, with the secret key. Reads
-- are governed by the same organization policy as every other table.

-- Which stage a run is in, or failed in. Null before it starts and after it
-- completes.
alter table public.analyses
  add column stage text
    check (stage in ('fetching', 'selecting', 'parsing', 'storing')),
  add column parser_version integer check (parser_version > 0),
  add column adapter text check (length(adapter) between 1 and 64),
  -- The parser's coverage summary, kept whole: it's one object read and shown
  -- as one, never queried into.
  add column coverage jsonb check (jsonb_typeof(coverage) = 'object');

-- GitHub owner and repository names are case-insensitive: "Vercel/Next.js" is
-- the same repository as "vercel/next.js", so it's the same project.
create unique index projects_org_id_repo_lower_key
  on public.projects (org_id, lower(repo_owner), lower(repo_name));

alter table public.files
  add column folder text not null check (length(folder) between 1 and 1024),
  add column language text not null check (length(language) between 1 and 64),
  add column lines integer check (lines >= 0),
  add column bytes bigint not null check (bytes >= 0),
  add column sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  add column module text,
  add column status text not null check (status in ('parsed', 'skipped')),
  add column skip_reason text,
  add column had_syntax_errors boolean,
  -- A skipped file always says why; a parsed one never carries a reason.
  add constraint files_skip_reason_check
    check ((status = 'skipped') = (skip_reason is not null));

-- The parser's six import kinds. "require" was a guess at a kind before the
-- parser existed; it doesn't produce one.
alter table public.edges drop constraint edges_kind_check;
alter table public.edges add constraint edges_kind_check
  check (kind in ('import', 're-export', 'dynamic', 'include', 'module-declaration', 'reference'));

-- Every import that didn't become an edge, with the reason. Resolved imports
-- are the edges themselves; these are what the map can't draw, and why.
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  from_file_id uuid not null,
  specifier text not null check (length(specifier) between 1 and 2048),
  kind text not null
    check (kind in ('import', 're-export', 'dynamic', 'include', 'module-declaration', 'reference')),
  line integer not null check (line > 0),
  outcome text not null check (outcome in ('external', 'excluded', 'unresolved')),
  reason text not null check (length(reason) > 0),
  foreign key (analysis_id, org_id)
    references public.analyses (id, org_id) on delete cascade,
  foreign key (from_file_id, org_id)
    references public.files (id, org_id) on delete cascade
);

create index imports_org_id_idx on public.imports (org_id);
create index imports_analysis_id_org_id_idx on public.imports (analysis_id, org_id);
create index imports_from_file_id_org_id_idx on public.imports (from_file_id, org_id);

-- RLS is already on (the event trigger enables it on every new table). Same
-- grant and the same single predicate as the rest of the schema.
revoke all on public.imports from anon, authenticated;
grant select on public.imports to authenticated;

create policy "members read their organization's rows" on public.imports
  for select to authenticated
  using (org_id = (select private.current_org_id()));
