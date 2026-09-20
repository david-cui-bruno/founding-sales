-- 0002_jobs
--
-- The job system of specification 13 (claims, leases, retries, dead jobs, the
-- one-minute scheduler, daily counters, heartbeats, the canary and the alert
-- acknowledgement the composite alarm reads). Migration 0001 fixed the shape of
-- `jobs`, `daily_counters` and `heartbeats`; this file adds only what the claim,
-- the lease, the retry ladder, archival and the metrics need, plus the two tables
-- that had no home before: `canary_runs` and `critical_alerts`.
--
-- Expand only (docs/greenfield/migrations.md). Every added column is nullable or
-- carries a default, every added table is unreferenced by an older binary, and the
-- cross-column CHECKs are NOT VALID so a row written by the previous release is
-- untouched while every new write is checked. Nothing here changes migration 0001.

-- ---------------------------------------------------------------------------
-- jobs: the fencing token, the timings the metrics read, and archival
--
-- `fencing_token` is the monotonic counter of specification 13.2's "monotonic
-- fencing token". It increments on every claim and NEVER resets — not on a retry,
-- not on an admin requeue — so a worker that wakes after its lease expired holds a
-- token the row no longer carries and its write affects zero rows. `attempt_count`
-- cannot serve: a requeue resets it, and a reset fence is not a fence.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN claimed_at timestamptz;
ALTER TABLE jobs ADD COLUMN completed_at timestamptz;
ALTER TABLE jobs ADD COLUMN dead_at timestamptz;
ALTER TABLE jobs ADD COLUMN error_code text;
ALTER TABLE jobs ADD COLUMN payload_archived_at timestamptz;
ALTER TABLE jobs ADD COLUMN requeued_count integer NOT NULL DEFAULT 0;

ALTER TABLE jobs ADD CONSTRAINT jobs_fencing_token_nonnegative
  CHECK (fencing_token >= 0);

ALTER TABLE jobs ADD CONSTRAINT jobs_requeued_count_nonnegative
  CHECK (requeued_count >= 0);

-- A short stable code, not a sentence: the sentence is in `error_detail`, bounded
-- and redacted by 0001, and the code is what an alarm and a dead-job list group by.
ALTER TABLE jobs ADD CONSTRAINT jobs_error_code_shape
  CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{2,63}$');

ALTER TABLE jobs ADD CONSTRAINT jobs_completed_at_consistent
  CHECK ((state = 'done') = (completed_at IS NOT NULL)) NOT VALID;

ALTER TABLE jobs ADD CONSTRAINT jobs_dead_at_consistent
  CHECK ((state = 'dead') = (dead_at IS NOT NULL)) NOT VALID;

-- Only a completed payload is archived. A dead job keeps its payload, because an
-- audited admin requeue has to have something to run (13.2).
ALTER TABLE jobs ADD CONSTRAINT jobs_payload_archived_only_when_done
  CHECK (payload_archived_at IS NULL OR (state = 'done' AND completed_at IS NOT NULL)) NOT VALID;

-- The runner claims the kinds it has handlers registered for, so the claim
-- predicate names `kind`; the 0001 index leads on `run_at` and cannot serve it.
CREATE INDEX jobs_runnable_by_kind
  ON jobs (kind, run_at, not_before, id)
  WHERE state IN ('queued', 'retryable');

-- The admin dead-job list, and DeadJobOldestAgeSeconds.
CREATE INDEX jobs_dead
  ON jobs (workspace_id, dead_at)
  WHERE state = 'dead';

-- The archival sweep: completed payloads after the operational window (13.2).
CREATE INDEX jobs_archivable
  ON jobs (completed_at)
  WHERE state = 'done' AND payload_archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- heartbeats: how often the component promises to arrive
--
-- "Three missed one-minute scheduler or mailbox checks" is a threshold over an
-- interval, and the interval belongs beside the beat rather than in a constant the
-- alarm and the emitter each keep their own copy of.
-- ---------------------------------------------------------------------------
ALTER TABLE heartbeats ADD COLUMN expected_interval_seconds integer NOT NULL DEFAULT 60;

ALTER TABLE heartbeats ADD CONSTRAINT heartbeats_expected_interval_positive
  CHECK (expected_interval_seconds > 0 AND expected_interval_seconds <= 86400);

-- ---------------------------------------------------------------------------
-- canary_runs (specification 13.3, Appendix C `canary:{quarter_hour}`)
--
-- The scheduler inserts the row for the current quarter hour; the worker completes
-- it. The pair proves scheduler-to-worker liveness, which neither heartbeat can:
-- a scheduler that inserts and a worker that never claims both look alive alone.
--
-- `quarter_hour` is the identity, so the idempotency of Appendix C is the primary
-- key rather than a convention. Alignment is checked on the epoch, because
-- date_trunc(text, timestamptz) is STABLE (it reads TimeZone) and a CHECK may not
-- call it.
-- ---------------------------------------------------------------------------
CREATE TABLE canary_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  quarter_hour timestamptz NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by text,
  CONSTRAINT canary_runs_pkey PRIMARY KEY (workspace_id, quarter_hour),
  CONSTRAINT canary_runs_quarter_hour_aligned
    CHECK (mod(floor(extract(epoch FROM quarter_hour))::bigint, 900) = 0),
  CONSTRAINT canary_runs_completed_after_insert
    CHECK (completed_at IS NULL OR completed_at >= inserted_at),
  CONSTRAINT canary_runs_completion_attributed
    CHECK ((completed_at IS NULL) = (completed_by IS NULL)),
  CONSTRAINT canary_runs_completed_by_bounded
    CHECK (completed_by IS NULL OR (btrim(completed_by) <> '' AND length(completed_by) <= 120))
);

-- CanaryCompletionAgeSeconds reads the newest completion.
CREATE INDEX canary_runs_completed
  ON canary_runs (workspace_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- critical_alerts (specification 13.3, docs/decisions/g1-alert-repetition.md)
--
-- CloudWatch notifies on state transitions, so "repeated while critical and
-- unacknowledged" is delivered by the application: the worker publishes the age of
-- the oldest unacknowledged critical alert as `UnacknowledgedCriticalAlertAgeSeconds`
-- and an admin acknowledge command clears it. That makes "which alert, raised when,
-- acknowledged by whom" business state, and business state lives here with the audit
-- trail rather than in an AWS console.
-- ---------------------------------------------------------------------------
CREATE TABLE critical_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  alert_key text NOT NULL,
  severity text NOT NULL DEFAULT 'critical',
  raised_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  acknowledged_by_user_id uuid,
  resolved_at timestamptz,
  CONSTRAINT critical_alerts_pkey PRIMARY KEY (workspace_id, id),
  -- MATCH SIMPLE: a null acknowledger skips the check entirely, which is what an
  -- unacknowledged alert is.
  CONSTRAINT critical_alerts_acknowledger_fkey
    FOREIGN KEY (workspace_id, acknowledged_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT critical_alerts_key_shape CHECK (alert_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT critical_alerts_severity_known CHECK (severity IN ('critical', 'warning')),
  CONSTRAINT critical_alerts_detail_is_object CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT critical_alerts_acknowledgement_attributed
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by_user_id IS NULL)),
  CONSTRAINT critical_alerts_acknowledged_after_raise
    CHECK (acknowledged_at IS NULL OR acknowledged_at >= raised_at),
  CONSTRAINT critical_alerts_resolved_after_raise
    CHECK (resolved_at IS NULL OR resolved_at >= raised_at),
  CONSTRAINT critical_alerts_observed_after_raise
    CHECK (last_observed_at >= raised_at)
);

-- One open alert per key: the condition recurring updates the open row rather than
-- filling the table, so the age the metric publishes is the age of the condition
-- and not the age of the last observation of it.
CREATE UNIQUE INDEX critical_alerts_one_open_per_key
  ON critical_alerts (workspace_id, alert_key)
  WHERE resolved_at IS NULL;

-- UnacknowledgedCriticalAlertAgeSeconds reads the oldest of these.
CREATE INDEX critical_alerts_unacknowledged
  ON critical_alerts (workspace_id, raised_at)
  WHERE acknowledged_at IS NULL AND resolved_at IS NULL AND severity = 'critical';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- 0001's GRANT covered the tables that existed then; a new table needs its own
-- (docs/greenfield/migrations.md, checklist step 5). Neither table is append-only:
-- an acknowledgement is an UPDATE, and so is a canary completion.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON canary_runs TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON critical_alerts TO app_runtime, migration;
