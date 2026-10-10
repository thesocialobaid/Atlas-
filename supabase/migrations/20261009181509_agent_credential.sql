-- The agent's credential: a short-lived signed token that names one analysis
-- and its organization, and lets its holder read that analysis and nothing
-- else, without a signed-in user.
--
-- Both ends live here. The signing key is generated in the database and never
-- leaves it: the app can ask for a credential, but it holds nothing that could
-- forge one. Reading with it is anonymous plus a header, and what comes back
-- is decided by the policies below, which check the signature themselves. No
-- part of the system holds a key that reads every organization's rows.

-- 32 random bytes, encrypted at rest by Vault. Rotating it ends every
-- credential at once, which is what rotation should do.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'agent_credential_key',
  'Signs the short-lived credentials the agent reads one analysis with.'
);

create function private.agent_key()
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select decode(decrypted_secret, 'hex')
  from vault.decrypted_secrets
  where name = 'agent_credential_key';
$$;

revoke execute on function private.agent_key() from public, anon, authenticated;

create function private.base64url(data bytea)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(rtrim(encode(data, 'base64'), '='), E'+/\n', '-_');
$$;

create function private.base64url_decode(text text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select decode(rpad(translate(text, '-_', '+/'), (length(text) + 3) / 4 * 4, '='), 'base64');
$$;

-- A JWT with HS256, so any tool can decode it to see what it names. Only the
-- signature makes it worth anything, and only this database can make one.
create function private.sign_agent_credential(analysis uuid, org text, lifetime_seconds integer)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with parts as (
    select
      private.base64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8')) as header,
      private.base64url(convert_to(json_build_object(
        'aud', 'atlas-agent',
        'sub', analysis,
        'org_id', org,
        'iat', extract(epoch from now())::bigint,
        'exp', extract(epoch from now())::bigint + lifetime_seconds
      )::text, 'utf8')) as payload
  )
  select header || '.' || payload || '.' ||
    private.base64url(extensions.hmac(convert_to(header || '.' || payload, 'utf8'), private.agent_key(), 'sha256'))
  from parts;
$$;

revoke execute on function private.sign_agent_credential(uuid, text, integer) from public, anon, authenticated;

-- A credential for one analysis, asked for by a signed-in member. Null unless
-- the analysis is finished and belongs to the caller's active organization:
-- the same predicate as the read policy, applied here because signing has to
-- run with the key's privileges.
--
-- Ten minutes: long enough for one answer's lookups, short enough that a
-- credential seen in a trace or a log is worthless by the time anyone reads it.
create function public.mint_agent_credential(analysis uuid)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select private.sign_agent_credential(a.id, a.org_id, 600)
  from public.analyses a
  where a.id = analysis
    and a.org_id = (select private.current_org_id())
    and a.status = 'complete';
$$;

revoke execute on function public.mint_agent_credential(uuid) from public, anon;
grant execute on function public.mint_agent_credential(uuid) to authenticated;

-- What the request's credential names, or null when there isn't one, it's
-- malformed, its signature doesn't match, or it has expired. Never an error:
-- a bad credential reads nothing, the same as no credential.
create function private.agent_claims()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  token text := current_setting('request.headers', true)::json ->> 'x-atlas-credential';
  parts text[];
  claims jsonb;
begin
  if token is null then
    return null;
  end if;
  parts := string_to_array(token, '.');
  if array_length(parts, 1) <> 3
    or parts[1] <> private.base64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'utf8'))
    or parts[3] <> private.base64url(
      extensions.hmac(convert_to(parts[1] || '.' || parts[2], 'utf8'), private.agent_key(), 'sha256'))
  then
    return null;
  end if;
  claims := convert_from(private.base64url_decode(parts[2]), 'utf8')::jsonb;
  if claims ->> 'aud' is distinct from 'atlas-agent'
    or (claims ->> 'exp')::bigint <= extract(epoch from now())
  then
    return null;
  end if;
  return claims;
exception when others then
  return null;
end;
$$;

create function private.agent_analysis()
returns uuid
language sql
stable
set search_path = ''
as $$
  select (private.agent_claims() ->> 'sub')::uuid;
$$;

create function private.agent_org()
returns text
language sql
stable
set search_path = ''
as $$
  select private.agent_claims() ->> 'org_id';
$$;

grant usage on schema private to anon;
grant execute on function private.agent_claims(), private.agent_analysis(), private.agent_org() to anon;

-- Anonymous callers could read nothing before this; with a valid credential
-- they read the one analysis it names. Each check is wrapped in a select so
-- it's evaluated once per query, not once per row.
grant select on
  public.projects, public.analyses, public.files, public.edges,
  public.imports, public.routes, public.file_roles
to anon;

create policy "a credential reads its analysis" on public.analyses
  for select to anon
  using (id = (select private.agent_analysis()) and org_id = (select private.agent_org()));

create policy "a credential reads its analysis's repository" on public.projects
  for select to anon
  using (
    org_id = (select private.agent_org())
    and id = (select a.project_id from public.analyses a where a.id = (select private.agent_analysis()))
  );

create policy "a credential reads its analysis" on public.files
  for select to anon
  using (analysis_id = (select private.agent_analysis()) and org_id = (select private.agent_org()));

create policy "a credential reads its analysis" on public.edges
  for select to anon
  using (analysis_id = (select private.agent_analysis()) and org_id = (select private.agent_org()));

create policy "a credential reads its analysis" on public.imports
  for select to anon
  using (analysis_id = (select private.agent_analysis()) and org_id = (select private.agent_org()));

create policy "a credential reads its analysis" on public.routes
  for select to anon
  using (
    org_id = (select private.agent_org())
    and file_id in (select f.id from public.files f where f.analysis_id = (select private.agent_analysis()))
  );

create policy "a credential reads its analysis" on public.file_roles
  for select to anon
  using (
    org_id = (select private.agent_org())
    and file_id in (select f.id from public.files f where f.analysis_id = (select private.agent_analysis()))
  );
