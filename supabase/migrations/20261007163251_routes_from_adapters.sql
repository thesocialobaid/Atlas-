-- Routes and roles from framework adapters. Several frameworks can apply to
-- one repository, so every route and role records which adapter read it.
-- Nothing has written to routes or file_roles yet, so the new columns can be
-- required outright.

-- Where the route is declared, so a pattern can be checked against its line,
-- and which framework's rules produced it.
alter table public.routes
  add column line integer not null check (line > 0),
  add column framework text not null check (length(framework) between 1 and 64);

alter table public.file_roles
  add column framework text not null check (length(framework) between 1 and 64);

-- Every adapter that owned a file, in detection order; empty when none
-- matched. Replaces the single `adapter` column for analyses stored from now
-- on; older rows keep theirs and leave this null.
--
-- Routes the adapters could see but couldn't read exactly, grouped by reason
-- (the parser's routesWithheld). Kept whole, like coverage: read and shown as
-- one object, never queried into. Null on analyses stored before routes were
-- read.
alter table public.analyses
  add column adapters text[],
  add column routes_withheld jsonb check (jsonb_typeof(routes_withheld) = 'array');
