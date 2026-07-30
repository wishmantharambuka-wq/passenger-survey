-- Let every project participant read the whole project's taps.
--
-- Why: the results screen offers a download button for EVERY node (A, B, C…)
-- to every member. Under the old "read own taps" policy a non-admin would
-- silently download an empty file for anyone else's node — the query returns
-- zero rows rather than an error, so it looks like a data-loss bug.
--
-- This is a collaborative survey team working one shared project; there is no
-- confidentiality boundary between members. Insert stays locked down: you can
-- still only write taps for yourself, in an active project.

drop policy if exists "read own taps" on taps;

create policy "read project taps" on taps
  for select using (in_project(project_id));
