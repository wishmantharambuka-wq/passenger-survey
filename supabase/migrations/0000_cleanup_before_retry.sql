-- Run this ONCE before re-running 0001_init.sql if the previous attempt
-- created any objects. Safe: only touches this app's own tables.

drop table if exists flow_estimates cascade;
drop table if exists tap_bins cascade;
drop table if exists taps cascade;
drop table if exists project_edges cascade;
drop table if exists project_participants cascade;
drop table if exists projects cascade;

-- old model, if 0001 v1 was ever applied
drop table if exists count_bins cascade;
drop table if exists count_events cascade;
drop table if exists assignments cascade;
drop table if exists sessions cascade;
drop table if exists edges cascade;
drop table if exists nodes cascade;
drop table if exists surveys cascade;
drop table if exists profiles cascade;

drop function if exists create_project           cascade;
drop function if exists join_project             cascade;
drop function if exists set_participant_ready    cascade;
drop function if exists begin_mapping            cascade;
drop function if exists start_project            cascade;
drop function if exists stop_project             cascade;
drop function if exists _fresh_join_code         cascade;
drop function if exists check_participant_cap    cascade;
drop function if exists set_edge_length          cascade;
drop function if exists set_tap_occurred_at      cascade;
drop function if exists set_occurred_at          cascade;
drop function if exists fold_tap_into_bin        cascade;
drop function if exists fold_event_into_bin      cascade;
drop function if exists is_coordinator           cascade;
drop function if exists in_session               cascade;
drop function if exists in_project               cascade;
drop function if exists is_admin                 cascade;
drop function if exists server_now               cascade;

drop type if exists junction_kind   cascade;
drop type if exists project_status  cascade;
drop type if exists node_kind       cascade;
drop type if exists user_role       cascade;
drop type if exists session_status  cascade;

-- realtime publication members are dropped with their tables
