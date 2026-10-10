-- The agent's credential lives two minutes, not ten.
--
-- LangChain records a run's context on every model call it traces, so the
-- credential sits in the agent's LangSmith traces. Every question mints a
-- fresh one and an answer takes under thirty seconds, so two minutes covers
-- one answer's lookups with room to spare, and a copy found in a trace has
-- almost certainly expired before anyone reads it.

create or replace function public.mint_agent_credential(analysis uuid)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select private.sign_agent_credential(a.id, a.org_id, 120)
  from public.analyses a
  where a.id = analysis
    and a.org_id = (select private.current_org_id())
    and a.status = 'complete';
$$;

revoke execute on function public.mint_agent_credential(uuid) from public, anon;
grant execute on function public.mint_agent_credential(uuid) to authenticated;
