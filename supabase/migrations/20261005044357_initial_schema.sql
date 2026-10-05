-- Initial schema: one organization table and the eight tables that belong to it.
--
-- Authorization lives here, not in the app. Every table carries org_id, every
-- policy compares it to the organization claim on the Clerk session token, and
-- nothing else decides who reads what.

create schema if not exists private;
grant usage on schema private to authenticated;

-- RLS on by default, not per table. A table created without it would return
-- every row to every caller; this makes that impossible rather than unlikely.
create or replace function private.enable_rls_on_new_tables()
returns event_trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  obj record;
begin
  for obj in
    select object_identity
    from pg_event_trigger_ddl_commands()
    where object_type = 'table' and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', obj.object_identity);
    execute format('alter table %s force row level security', obj.object_identity);
  end loop;
end;
$$;

create event trigger enable_rls_on_new_tables
  on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function private.enable_rls_on_new_tables();

-- The active organization, read off the token (Clerk session token v2 puts it
-- at o.id). Null when the session has no active organization, which matches
-- no row.
create or replace function private.current_org_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() -> 'o' ->> 'id', '');
$$;

grant execute on function private.current_org_id() to authenticated;

-- Organizations are owned by Clerk; this row exists so every table below has
-- something to cascade from. Keyed by the Clerk org id, nothing else copied.
create table public.organizations (
  id text primary key check (id ~ '^org_[A-Za-z0-9]+$'),
  created_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  repo_owner text not null check (repo_owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  repo_name text not null check (repo_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  created_at timestamptz not null default now(),
  unique (org_id, repo_owner, repo_name),
  -- Lets children reference (id, org_id) so a row can't point across orgs.
  unique (id, org_id)
);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  project_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'failed')),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (project_id, org_id)
    references public.projects (id, org_id) on delete cascade,
  unique (id, org_id),
  -- A failure always says why; nothing else carries an error.
  check ((status = 'failed') = (error is not null)),
  check ((status in ('complete', 'failed')) = (finished_at is not null))
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  path text not null check (length(path) between 1 and 1024),
  foreign key (analysis_id, org_id)
    references public.analyses (id, org_id) on delete cascade,
  unique (analysis_id, path),
  unique (id, org_id)
);

create table public.edges (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  from_file_id uuid not null,
  to_file_id uuid not null,
  kind text not null check (kind in ('import', 're-export', 'dynamic', 'require')),
  foreign key (analysis_id, org_id)
    references public.analyses (id, org_id) on delete cascade,
  foreign key (from_file_id, org_id)
    references public.files (id, org_id) on delete cascade,
  foreign key (to_file_id, org_id)
    references public.files (id, org_id) on delete cascade,
  unique (from_file_id, to_file_id, kind)
);

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  file_id uuid not null,
  method text not null
    check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  path text not null check (path like '/%'),
  foreign key (file_id, org_id)
    references public.files (id, org_id) on delete cascade,
  unique (file_id, method, path)
);

create table public.explanations (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  file_id uuid not null,
  body text not null check (length(body) > 0),
  created_at timestamptz not null default now(),
  foreign key (file_id, org_id)
    references public.files (id, org_id) on delete cascade
);

create table public.file_roles (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  file_id uuid not null,
  role text not null check (length(role) between 1 and 64),
  -- Convention is what an adapter recognised; label is what the model was
  -- asked for because convention couldn't tell.
  source text not null check (source in ('convention', 'label')),
  foreign key (file_id, org_id)
    references public.files (id, org_id) on delete cascade,
  unique (file_id)
);

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  analysis_id uuid not null,
  body text not null check (length(body) > 0),
  created_at timestamptz not null default now(),
  foreign key (analysis_id, org_id)
    references public.analyses (id, org_id) on delete cascade
);

-- Foreign keys aren't indexed automatically; cascades and the policy
-- predicate both need these.
create index projects_org_id_idx on public.projects (org_id);
create index analyses_org_id_created_at_idx on public.analyses (org_id, created_at desc);
create index analyses_project_id_idx on public.analyses (project_id);
create index files_org_id_idx on public.files (org_id);
create index edges_org_id_idx on public.edges (org_id);
create index edges_analysis_id_idx on public.edges (analysis_id);
create index edges_to_file_id_idx on public.edges (to_file_id);
create index routes_org_id_idx on public.routes (org_id);
create index explanations_org_id_idx on public.explanations (org_id);
create index explanations_file_id_idx on public.explanations (file_id);
create index file_roles_org_id_idx on public.file_roles (org_id);
create index insights_org_id_idx on public.insights (org_id);
create index insights_analysis_id_idx on public.insights (analysis_id);

-- Read-only for signed-in users, nothing for anonymous callers. Writes come
-- with the phases that create rows, each with its own policy.
revoke all on
  public.organizations, public.projects, public.analyses, public.files,
  public.edges, public.routes, public.explanations, public.file_roles,
  public.insights
from anon, authenticated;

grant select on
  public.organizations, public.projects, public.analyses, public.files,
  public.edges, public.routes, public.explanations, public.file_roles,
  public.insights
to authenticated;

-- The event trigger already enabled and forced RLS on each table above; these
-- are the policies. One predicate, the same on every table.
create policy "members read their organization" on public.organizations
  for select to authenticated
  using (id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.projects
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.analyses
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.files
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.edges
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.routes
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.explanations
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.file_roles
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members read their organization's rows" on public.insights
  for select to authenticated
  using (org_id = (select private.current_org_id()));
