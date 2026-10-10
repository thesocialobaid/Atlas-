-- The credential helpers kept Postgres's default: every new function is
-- executable by PUBLIC. Only anon needs the three the read policies call,
-- and it has them by name; nobody calls the encoding helpers directly.

revoke execute on function
  private.agent_claims(),
  private.agent_analysis(),
  private.agent_org(),
  private.base64url(bytea),
  private.base64url_decode(text)
from public;

grant execute on function private.agent_claims(), private.agent_analysis(), private.agent_org() to anon;
