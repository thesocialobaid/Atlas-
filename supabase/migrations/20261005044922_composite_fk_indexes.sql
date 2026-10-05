-- The tenant-safe foreign keys are composite (parent id, org_id), so cascades
-- need an index covering both columns. These replace the single-column ones.

drop index public.analyses_project_id_idx;
drop index public.edges_analysis_id_idx;
drop index public.edges_to_file_id_idx;
drop index public.explanations_file_id_idx;
drop index public.insights_analysis_id_idx;

create index analyses_project_id_org_id_idx on public.analyses (project_id, org_id);
create index files_analysis_id_org_id_idx on public.files (analysis_id, org_id);
create index edges_analysis_id_org_id_idx on public.edges (analysis_id, org_id);
create index edges_from_file_id_org_id_idx on public.edges (from_file_id, org_id);
create index edges_to_file_id_org_id_idx on public.edges (to_file_id, org_id);
create index routes_file_id_org_id_idx on public.routes (file_id, org_id);
create index explanations_file_id_org_id_idx on public.explanations (file_id, org_id);
create index file_roles_file_id_org_id_idx on public.file_roles (file_id, org_id);
create index insights_analysis_id_org_id_idx on public.insights (analysis_id, org_id);
