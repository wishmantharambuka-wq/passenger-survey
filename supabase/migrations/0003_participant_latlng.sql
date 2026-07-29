-- Add plain lat/lng columns to project_participants.
--
-- Why: PostgREST returns PostGIS geography columns as WKB hex text, so the
-- client can't do `p.location.coordinates[0]` — it's undefined, and the
-- admin map view crashes with a client-side exception on Vercel.
--
-- We keep the geography column too, in case a future feature wants to do
-- spatial queries in SQL, but the client reads lat/lng instead.
--
-- Safe to run on an existing database.

alter table project_participants
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Backfill from any existing rows that already have a geography set.
update project_participants
   set lat = st_y(location::geometry),
       lng = st_x(location::geometry)
 where location is not null and lat is null;

create or replace function set_participant_ready(
  p_project uuid, p_kind junction_kind,
  p_lat double precision, p_lng double precision,
  p_acc double precision default null
) returns void
language plpgsql security definer as $$
begin
  update project_participants pp
     set junction_kind  = p_kind,
         lat            = p_lat,
         lng            = p_lng,
         location       = st_setsrid(st_point(p_lng, p_lat), 4326)::geography,
         gps_accuracy_m = p_acc,
         last_seen_at   = now(),
         ready          = true
   where pp.project_id = p_project and pp.user_id = auth.uid();
  if not found then raise exception 'not a participant' using errcode='P0004'; end if;
end $$;
