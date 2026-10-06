-- One analysis per repository is checked in the app before inserting, but two
-- submissions at the same moment can both pass that check. The database
-- settles it: a repository has at most one analysis queued or running, so
-- the second insert is refused and that request is sent to the first's run.
create unique index analyses_one_active_per_project
  on public.analyses (project_id)
  where status in ('queued', 'running');
