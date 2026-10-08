-- The parser now reads CommonJS require() as its own kind.
alter table public.edges drop constraint edges_kind_check;
alter table public.edges add constraint edges_kind_check
  check (kind in ('import', 're-export', 'dynamic', 'include', 'module-declaration', 'reference', 'require'));

alter table public.imports drop constraint imports_kind_check;
alter table public.imports add constraint imports_kind_check
  check (kind in ('import', 're-export', 'dynamic', 'include', 'module-declaration', 'reference', 'require'));
