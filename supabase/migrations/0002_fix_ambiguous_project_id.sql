-- Fix "column reference project_id is ambiguous" in RPCs.
--
-- Cause: `returns table(project_id uuid)` creates an OUT parameter that
-- shares a namespace with real table columns inside the function body.
-- Any `where project_id = ...` then becomes ambiguous. Fix: qualify every
-- column reference with its table alias.
--
-- Safe to run on an existing database — only replaces function bodies.

create or replace function create_project(project_name text)
returns table(project_id uuid, join_code text)
language plpgsql security definer as $$
declare pid uuid; code text; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into profiles(id) values (uid) on conflict (id) do nothing;

  code := _fresh_join_code();
  insert into projects (join_code, name, admin_id, status)
    values (code, project_name, uid, 'lobby')
    returning projects.id into pid;

  insert into project_participants (project_id, user_id, join_order)
    values (pid, uid, 1);

  return query select pid, code;
end $$;

create or replace function join_project(code text)
returns table(project_id uuid)
language plpgsql security definer as $$
declare pid uuid; st project_status; next_order int; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into profiles(id) values (uid) on conflict (id) do nothing;

  select projects.id, projects.status
    into pid, st
    from projects
    where projects.join_code = join_project.code
      and projects.status <> 'closed'
    order by projects.created_at desc limit 1;
  if pid is null then raise exception 'no open project with that code' using errcode='P0002'; end if;
  if st <> 'lobby' then raise exception 'project already started' using errcode='P0003'; end if;

  if exists (
    select 1 from project_participants pp
      where pp.project_id = pid and pp.user_id = uid
  ) then
    return query select pid; return;
  end if;

  select coalesce(max(pp.join_order), 0) + 1
    into next_order
    from project_participants pp
    where pp.project_id = pid;

  insert into project_participants (project_id, user_id, join_order)
    values (pid, uid, next_order);

  return query select pid;
end $$;

create or replace function check_participant_cap() returns trigger
language plpgsql as $$
declare cnt int;
begin
  select count(*) into cnt
    from project_participants pp
    where pp.project_id = new.project_id;
  if cnt >= (select p.max_participants from projects p where p.id = new.project_id) then
    raise exception 'project is full' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function set_participant_ready(
  p_project uuid, p_kind junction_kind,
  p_lat double precision, p_lng double precision,
  p_acc double precision default null
) returns void
language plpgsql security definer as $$
begin
  update project_participants pp
     set junction_kind  = p_kind,
         location       = st_setsrid(st_point(p_lng, p_lat), 4326)::geography,
         gps_accuracy_m = p_acc,
         last_seen_at   = now(),
         ready          = true
   where pp.project_id = p_project and pp.user_id = auth.uid();
  if not found then raise exception 'not a participant' using errcode='P0004'; end if;
end $$;

create or replace function begin_mapping(p_project uuid) returns void
language plpgsql security definer as $$
declare not_ready int;
begin
  if not exists (
    select 1 from projects p where p.id = p_project and p.admin_id = auth.uid()
  ) then raise exception 'not the admin' using errcode='P0005'; end if;

  select count(*) into not_ready
    from project_participants pp
    where pp.project_id = p_project and not pp.ready;
  if not_ready > 0 then
    raise exception 'still waiting for % participant(s)', not_ready using errcode='P0006';
  end if;

  update projects p set status = 'mapping' where p.id = p_project;
end $$;

create or replace function start_project(p_project uuid) returns void
language plpgsql security definer as $$
begin
  if not exists (
    select 1 from projects p where p.id = p_project and p.admin_id = auth.uid()
  ) then raise exception 'not the admin' using errcode='P0005'; end if;

  if not exists (
    select 1 from project_edges e where e.project_id = p_project
  ) then raise exception 'no edges drawn yet' using errcode='P0007'; end if;

  update projects p set status = 'active', started_at = now() where p.id = p_project;
end $$;

create or replace function stop_project(p_project uuid) returns void
language plpgsql security definer as $$
begin
  if not exists (
    select 1 from projects p where p.id = p_project and p.admin_id = auth.uid()
  ) then raise exception 'not the admin' using errcode='P0005'; end if;

  update projects p set status = 'closed', ended_at = now() where p.id = p_project;
end $$;
