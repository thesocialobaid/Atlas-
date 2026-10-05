-- Seed rows for the dashboard until something creates real analyses. Two
-- organizations, so isolation is visible: switching between them must change
-- the list. Only analyses and projects are seeded. No files or edges, because
-- an edge that came from anywhere but the parser is the one thing this app
-- never shows. Fixed ids so re-running is a no-op.

insert into public.organizations (id) values
  ('org_3KGE97OuGRrmu7RcOp2VInnvyDa'),  -- demo
  ('org_3KEzBBYfdCWaobVHehhvtAZdGjV')   -- Muhammad's Organization
on conflict (id) do nothing;

insert into public.projects (id, org_id, repo_owner, repo_name) values
  ('00000000-0000-4000-8000-00000000a001', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', 'vercel', 'next.js'),
  ('00000000-0000-4000-8000-00000000a002', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', 'shadcn-ui', 'ui'),
  ('00000000-0000-4000-8000-00000000a003', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', 'facebook', 'react'),
  ('00000000-0000-4000-8000-00000000b001', 'org_3KEzBBYfdCWaobVHehhvtAZdGjV', 'supabase', 'supabase'),
  ('00000000-0000-4000-8000-00000000b002', 'org_3KEzBBYfdCWaobVHehhvtAZdGjV', 'clerk', 'javascript')
on conflict (id) do nothing;

insert into public.analyses (id, org_id, project_id, status, error, created_at, finished_at) values
  ('00000000-0000-4000-8000-0000000aa001', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', '00000000-0000-4000-8000-00000000a001',
    'complete', null, now() - interval '2 days', now() - interval '2 days' + interval '41 seconds'),
  ('00000000-0000-4000-8000-0000000aa002', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', '00000000-0000-4000-8000-00000000a002',
    'running', null, now() - interval '3 minutes', null),
  ('00000000-0000-4000-8000-0000000aa003', 'org_3KGE97OuGRrmu7RcOp2VInnvyDa', '00000000-0000-4000-8000-00000000a003',
    'failed', 'Seed row: no parser exists yet.', now() - interval '1 day', now() - interval '1 day' + interval '5 seconds'),
  ('00000000-0000-4000-8000-0000000bb001', 'org_3KEzBBYfdCWaobVHehhvtAZdGjV', '00000000-0000-4000-8000-00000000b001',
    'queued', null, now() - interval '10 minutes', null),
  ('00000000-0000-4000-8000-0000000bb002', 'org_3KEzBBYfdCWaobVHehhvtAZdGjV', '00000000-0000-4000-8000-00000000b002',
    'complete', null, now() - interval '6 hours', now() - interval '6 hours' + interval '18 seconds')
on conflict (id) do nothing;
