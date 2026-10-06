-- Symbolic links in a repository's archive are never unpacked: one pointing
-- outside the repository would let the parser read a file on the server. They
-- aren't parsed, so they're counted here, where coverage can say so.
alter table public.analyses
  add column links_skipped integer check (links_skipped >= 0);
