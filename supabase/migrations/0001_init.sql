-- Passenger Behaviour Survey — lobby/PIN schema
-- Requires: postgis, pgcrypto
--
-- Model: one PROJECT holds up to 10 PARTICIPANTS (each is a node), an admin
-- draws EDGES between them on a live map, then every participant switches to
-- a junction-diagram TAP UI. TAPS aggregate into TAP_BINS. Flow reconciliation
-- runs client-side against tap_bins.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- roles
-- ─────────────────────────────────────────────────────────────

create type junction_kind as enum ('straight', 't_junction', 'cross_junction', 'terminus', 'custom');
create type project_status as enum ('lobby', 'mapping', 'active', 'closed');

create table profiles (
  id          uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- projects: one PIN, one admin, a status machine
-- ─────────────────────────────────────────────────────────────

create table projects (
  id            uuid primary key default gen_random_uuid(),
  join_code     text not null unique,        -- 6 digits, human-typed on phone keypad
  name          text not null,
  admin_id      uuid not null references profiles(id),
  status        project_status not null default 'lobby',
  bin_seconds   int not null default 60 check (bin_seconds between 10 and 900),
  max_participants int not null default 10 check (max_participants between 2 and 10),
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);

create index on projects (join_code) where status <> 'closed';
create index on projects (admin_id);

-- ─────────────────────────────────────────────────────────────
-- participants ARE the nodes. code (A/B/C/…) comes from join_order.
-- ─────────────────────────────────────────────────────────────

create table project_participants (
  project_id     uuid not null references projects(id) on delete cascade,
  user_id        uuid not null references profiles(id) on delete cascade,
  join_order     int  not null check (join_order between 1 and 10),
  code           text generated always as (chr(64 + join_order)) stored,  -- 1→A, 2→B, …
  junction_kind  junction_kind,
  ready          boolean not null default false,
  location       geography(point, 4326),
  gps_accuracy_m real,
  last_seen_at   timestamptz,
  joined_at      timestamptz not null default now(),
  primary key (project_id, user_id),
  unique (project_id, join_order)
);

create index on project_participants (project_id, join_order);

-- enforce 2–10 cap at insert time
create or replace function check_participant_cap() returns trigger
language plpgsql as $$
declare cnt int;
begin
  select count(*) into cnt from project_participants where project_id = new.project_id;
  if cnt >= (select max_participants from projects where id = new.project_id) then
    raise exception 'project is full' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_participant_cap
  before insert on project_participants
  for each row execute function check_participant_cap();

-- ─────────────────────────────────────────────────────────────
-- edges: drawn by admin on the map, connecting two participants
-- ─────────────────────────────────────────────────────────────

create table project_edges (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  from_user     uuid not null references profiles(id) on delete cascade,
  to_user       uuid not null references profiles(id) on delete cascade,
  path          geography(linestring, 4326) not null,
  length_m      double precision,
  street_name   text,
  bidirectional boolean not null default true,
  created_at    timestamptz not null default now(),
  check (from_user <> to_user),
  unique (project_id, from_user, to_user)
);

create or replace function set_edge_length() returns trigger
language plpgsql as $$
begin new.length_m := st_length(new.path); return new; end $$;

create trigger trg_set_edge_length
  before insert or update of path on project_edges
  for each row execute function set_edge_length();

create index on project_edges (project_id);
create index on project_edges using gist (path);

-- ─────────────────────────────────────────────────────────────
-- taps: append-only. undo = delta -1, never DELETE.
-- ─────────────────────────────────────────────────────────────

create table taps (
  id                 uuid primary key,  -- client-generated → idempotent replay
  project_id         uuid not null references projects(id) on delete cascade,
  user_id            uuid not null references profiles(id),
  from_arm           text,              -- null at an origin/terminus
  to_arm             text not null,     -- points to a project_edges.id or a compass tag
  delta              smallint not null default 1 check (delta in (1, -1)),
  attributes         jsonb not null default '{}'::jsonb,

  -- clock discipline: device time + measured offset, applied by trigger
  occurred_at_device timestamptz not null,
  clock_offset_ms    int not null default 0,
  occurred_at        timestamptz,
  received_at        timestamptz not null default now(),

  device_id          text
);

create or replace function set_tap_occurred_at() returns trigger
language plpgsql as $$
begin
  new.occurred_at := new.occurred_at_device
                     + make_interval(secs => new.clock_offset_ms / 1000.0);
  return new;
end $$;

create trigger trg_tap_occurred_at
  before insert on taps
  for each row execute function set_tap_occurred_at();

create index on taps (project_id, user_id, occurred_at);
create index on taps (project_id, occurred_at);

-- ─────────────────────────────────────────────────────────────
-- tap_bins: one row per (participant, movement, minute). This is what
-- clients subscribe to — streaming raw taps to 10 devices is wasteful.
-- ─────────────────────────────────────────────────────────────

create table tap_bins (
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  from_arm    text not null default '',
  to_arm      text not null,
  bin_start   timestamptz not null,
  count       int not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (project_id, user_id, from_arm, to_arm, bin_start)
);

create index on tap_bins (project_id, bin_start);

create or replace function fold_tap_into_bin() returns trigger
language plpgsql security definer as $$
declare bin_sec int; bin_ts timestamptz;
begin
  select p.bin_seconds into bin_sec from projects p where p.id = new.project_id;
  bin_ts := to_timestamp(floor(extract(epoch from new.occurred_at) / bin_sec) * bin_sec);

  insert into tap_bins (project_id, user_id, from_arm, to_arm, bin_start, count)
  values (new.project_id, new.user_id, coalesce(new.from_arm, ''), new.to_arm, bin_ts, new.delta)
  on conflict (project_id, user_id, from_arm, to_arm, bin_start)
  do update set count = tap_bins.count + excluded.count, updated_at = now();
  return new;
end $$;

create trigger trg_fold_tap
  after insert on taps
  for each row execute function fold_tap_into_bin();

-- ─────────────────────────────────────────────────────────────
-- flow_estimates (algorithm output cache)
-- ─────────────────────────────────────────────────────────────

create table flow_estimates (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  path         text[] not null,               -- ['A','B','C']
  truncated_at int,                           -- null = full path completed; k = reached k, not k+1
  estimate     double precision not null,
  ci_low       double precision,
  ci_high      double precision,
  confidence   text not null default 'ok',
  method       text not null default 'pairwise_xcorr_v2',
  params       jsonb not null default '{}'::jsonb,
  computed_at  timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- RPCs — the lobby/PIN state machine
-- ─────────────────────────────────────────────────────────────

-- generate a 6-digit code that isn't in use by an OPEN project
create or replace function _fresh_join_code() returns text
language plpgsql as $$
declare code text; tries int := 0;
begin
  loop
    code := lpad(floor(random() * 1000000)::text, 6, '0');
    exit when not exists (
      select 1 from projects where join_code = code and status <> 'closed'
    );
    tries := tries + 1;
    if tries > 20 then raise exception 'could not allocate join code'; end if;
  end loop;
  return code;
end $$;

-- USER A: create a project → returns (id, join_code). The creator becomes
-- admin AND participant #1.
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
    returning id into pid;

  insert into project_participants (project_id, user_id, join_order)
    values (pid, uid, 1);

  return query select pid, code;
end $$;

-- USERS B..J: join with a code → returns project id. Fails if project is
-- past the lobby stage, or already full.
create or replace function join_project(code text)
returns table(project_id uuid)
language plpgsql security definer as $$
declare pid uuid; st project_status; next_order int; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into profiles(id) values (uid) on conflict (id) do nothing;

  select id, status into pid, st from projects
    where join_code = code and status <> 'closed'
    order by created_at desc limit 1;
  if pid is null then raise exception 'no open project with that code' using errcode='P0002'; end if;
  if st <> 'lobby' then raise exception 'project already started' using errcode='P0003'; end if;

  -- if already a participant, just return
  if exists (select 1 from project_participants where project_id = pid and user_id = uid) then
    return query select pid; return;
  end if;

  select coalesce(max(join_order), 0) + 1 into next_order
    from project_participants where project_id = pid;

  insert into project_participants (project_id, user_id, join_order)
    values (pid, uid, next_order);

  return query select pid;
end $$;

-- each participant: pick your junction, drop your pin, mark ready
create or replace function set_participant_ready(
  p_project uuid,
  p_kind    junction_kind,
  p_lat     double precision,
  p_lng     double precision,
  p_acc     double precision default null
) returns void
language plpgsql security definer as $$
begin
  update project_participants
     set junction_kind = p_kind,
         location      = st_setsrid(st_point(p_lng, p_lat), 4326)::geography,
         gps_accuracy_m = p_acc,
         last_seen_at  = now(),
         ready         = true
   where project_id = p_project and user_id = auth.uid();
  if not found then raise exception 'not a participant' using errcode='P0004'; end if;
end $$;

-- admin: once everyone is ready, advance to mapping stage
create or replace function begin_mapping(p_project uuid) returns void
language plpgsql security definer as $$
declare not_ready int;
begin
  if not exists (select 1 from projects where id = p_project and admin_id = auth.uid()) then
    raise exception 'not the admin' using errcode='P0005';
  end if;
  select count(*) into not_ready from project_participants
    where project_id = p_project and not ready;
  if not_ready > 0 then
    raise exception 'still waiting for % participant(s)', not_ready using errcode='P0006';
  end if;
  update projects set status = 'mapping' where id = p_project;
end $$;

-- admin: with edges drawn, flip everyone into counting UI
create or replace function start_project(p_project uuid) returns void
language plpgsql security definer as $$
begin
  if not exists (select 1 from projects where id = p_project and admin_id = auth.uid()) then
    raise exception 'not the admin' using errcode='P0005';
  end if;
  if not exists (select 1 from project_edges where project_id = p_project) then
    raise exception 'no edges drawn yet' using errcode='P0007';
  end if;
  update projects set status = 'active', started_at = now() where id = p_project;
end $$;

create or replace function stop_project(p_project uuid) returns void
language plpgsql security definer as $$
begin
  if not exists (select 1 from projects where id = p_project and admin_id = auth.uid()) then
    raise exception 'not the admin' using errcode='P0005';
  end if;
  update projects set status = 'closed', ended_at = now() where id = p_project;
end $$;

create or replace function server_now() returns timestamptz language sql stable as $$ select now() $$;

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────

alter table profiles              enable row level security;
alter table projects              enable row level security;
alter table project_participants  enable row level security;
alter table project_edges         enable row level security;
alter table taps                  enable row level security;
alter table tap_bins              enable row level security;
alter table flow_estimates        enable row level security;

create or replace function in_project(p uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from project_participants
                 where project_id = p and user_id = auth.uid());
$$;

create or replace function is_admin(p uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from projects where id = p and admin_id = auth.uid());
$$;

create policy "own profile" on profiles for select using (id = auth.uid());
create policy "upsert profile" on profiles for insert with check (id = auth.uid());

create policy "read project" on projects for select using (in_project(id));
create policy "admin update project" on projects for update using (is_admin(id));

create policy "read participants" on project_participants for select using (in_project(project_id));
create policy "self update participant" on project_participants for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "join sets self" on project_participants for insert
  with check (user_id = auth.uid());

create policy "read edges" on project_edges for select using (in_project(project_id));
create policy "admin writes edges" on project_edges for all
  using (is_admin(project_id)) with check (is_admin(project_id));

-- the important one: only a participant of an ACTIVE project can log taps,
-- and only for themselves
create policy "self tap during active" on taps for insert with check (
  user_id = auth.uid()
  and exists (select 1 from projects p
              join project_participants pp
                on pp.project_id = p.id and pp.user_id = auth.uid()
              where p.id = taps.project_id and p.status = 'active')
);
create policy "read own taps" on taps for select using (user_id = auth.uid() or is_admin(project_id));

create policy "read bins" on tap_bins for select using (in_project(project_id));
create policy "read estimates" on flow_estimates for select using (in_project(project_id));
create policy "admin writes estimates" on flow_estimates for all
  using (is_admin(project_id)) with check (is_admin(project_id));

-- realtime
alter publication supabase_realtime add table projects;
alter publication supabase_realtime add table project_participants;
alter publication supabase_realtime add table project_edges;
alter publication supabase_realtime add table tap_bins;
