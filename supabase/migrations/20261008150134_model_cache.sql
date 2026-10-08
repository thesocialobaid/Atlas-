-- What the model writes is cached by what it was shown, not by which row it
-- was about: the same file content, with the same neighbours, asked of the
-- same pinned model with the same prompt, is the same answer in any analysis.
-- The key is a hash of all of that, so re-pinning the model or changing the
-- prompt misses only its own entries.
--
-- This replaces the explanations table, which was keyed to a file row and
-- has never been written. It's left in place, unused: dropping a table is
-- the owner's call, not a migration's.

create table public.model_cache (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('file', 'folder', 'label')),
  cache_key text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  model text not null check (length(model) between 1 and 128),
  body text not null check (length(body) between 1 and 20000),
  created_at timestamptz not null default now(),
  unique (org_id, cache_key)
);

-- Explanations are asked for by a signed-in member, so they're written with
-- that member's token: the policy decides the organization, as it does for
-- reads. Labels are written by the pipeline with the secret key.
revoke all on public.model_cache from anon, authenticated;
grant select, insert on public.model_cache to authenticated;

create policy "members read their organization's rows" on public.model_cache
  for select to authenticated
  using (org_id = (select private.current_org_id()));

create policy "members add their organization's rows" on public.model_cache
  for insert to authenticated
  with check (org_id = (select private.current_org_id()));

-- Labelling files no convention recognised is a stage of its own, and its
-- outcome is a sentence the map shows: how many were labelled, and why any
-- weren't.
alter table public.analyses drop constraint analyses_stage_check;
alter table public.analyses add constraint analyses_stage_check
  check (stage in ('fetching', 'selecting', 'parsing', 'storing', 'labelling'));

alter table public.analyses
  add column label_note text check (length(label_note) between 1 and 500);
