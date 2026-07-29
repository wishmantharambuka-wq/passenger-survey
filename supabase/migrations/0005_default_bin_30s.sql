-- Default new projects to 30-second bins.
--
-- Note: the per-member Excel export re-bins directly from the raw `taps`
-- table at 30s, so it is correct regardless of this value. This default only
-- affects the live tap_bins used for realtime dashboards / reconciliation.

alter table projects alter column bin_seconds set default 30;

-- Optionally tighten existing OPEN projects to 30s too (safe — only changes
-- how future taps are bucketed, already-recorded raw taps are untouched).
update projects set bin_seconds = 30 where status in ('lobby', 'mapping', 'active');
