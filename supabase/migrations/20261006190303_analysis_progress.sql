-- Live progress. The pipeline writes its stage and a message to the analysis
-- row; a trigger on that row publishes them; the browser subscribes. Nothing
-- polls.
--
-- Two private topics, both declared here by the policy that lets anyone
-- receive them at all. Without a policy, a private topic delivers nothing.
--   analysis:<id>        one analysis, for its progress page
--   org:<org_id>:analyses every analysis in an organization, for the dashboard

-- What the run is doing right now, in words, and when it last moved. A run
-- that hasn't moved in a while is one that has stopped, which is how the
-- dashboard tells working from abandoned.
alter table public.analyses
  add column stage_message text check (length(stage_message) between 1 and 500),
  add column progressed_at timestamptz;

-- The payload is the stage and its message, never the row: the page shows it
-- as it arrives, with nothing to filter out and nothing to interpret. Status
-- rides along because "failed" and "complete" are stages the page must show.
create or replace function private.publish_analysis_progress()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  if tg_op = 'UPDATE'
    and new.status is not distinct from old.status
    and new.stage is not distinct from old.stage
    and new.stage_message is not distinct from old.stage_message
    and new.error is not distinct from old.error then
    return null;
  end if;

  payload := jsonb_build_object(
    'analysis_id', new.id,
    'status', new.status,
    'stage', new.stage,
    'message', coalesce(new.error, new.stage_message)
  );
  perform realtime.send(payload, 'progress', 'analysis:' || new.id::text, true);
  perform realtime.send(payload, 'progress', 'org:' || new.org_id || ':analyses', true);
  return null;
end;
$$;

-- On our own table. Nothing is attached to the realtime schema itself.
create trigger analyses_publish_progress
  after insert or update on public.analyses
  for each row execute function private.publish_analysis_progress();

-- Who may receive is a policy, like who may read: a member of the
-- organization, for that organization's topics only. There is no insert
-- policy, so no browser can publish to these topics.
create policy "members receive their organization's analysis progress"
  on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      (select realtime.topic()) = 'org:' || (select private.current_org_id()) || ':analyses'
      or exists (
        select 1
        from public.analyses a
        where 'analysis:' || a.id::text = (select realtime.topic())
          and a.org_id = (select private.current_org_id())
      )
    )
  );
