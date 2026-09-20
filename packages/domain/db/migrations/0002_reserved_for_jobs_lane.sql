-- 0002_reserved_for_jobs_lane
--
-- PLACEHOLDER. THE COORDINATOR DELETES THIS FILE WHEN LANE G5's REAL 0002 MERGES.
--
-- Lane G5 (jobs, scheduler, runner, counters, heartbeats) owns migration 0002 and
-- lane G2 (identity) owns 0003; the two lanes ran at the same time from the same
-- main, so on this branch alone there is a gap where G5's file will be.
-- `loadMigrations` refuses a gap — MIGRATION_VERSIONS_NOT_CONTIGUOUS — and that guard
-- is correct and stays. This file fills the gap with a statement that does nothing,
-- so that G2's branch can run its own gate.
--
-- On merge: delete this file and keep G5's `0002_jobs.sql`. Nothing outside the
-- migrations directory names migration 0002, so there is nothing else to change.
-- No long-lived database ever applies this file: greenfield test databases are
-- created and dropped per run, and no production database exists yet.
DO $reserved$
BEGIN
  NULL;
END
$reserved$;
