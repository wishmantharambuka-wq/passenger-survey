-- Allow the admin to start counting even if they haven't drawn any edges.
--
-- Edges remain useful for OD-path reconciliation (A→B→C), but they are not
-- required for per-node directional counting. Skipping the drawing step lets
-- a small survey get to counting immediately.

create or replace function start_project(p_project uuid) returns void
language plpgsql security definer as $$
begin
  if not exists (
    select 1 from projects p where p.id = p_project and p.admin_id = auth.uid()
  ) then raise exception 'not the admin' using errcode='P0005'; end if;

  update projects p set status = 'active', started_at = now() where p.id = p_project;
end $$;
