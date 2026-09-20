-- 0005_policy
--
-- Policy, suppression and dialing (specification revision 3: sections 9.1, 9.2,
-- 10.1, 10.2, 15 and Appendices A, D, E and G). Forward-only; this file never
-- changes once it has been applied anywhere. See docs/greenfield/migrations.md.
--
-- Migration 0001 already fixed the two tables this protocol is built on:
-- `suppression_events`, insert-only by privilege, and `active_holds`. What this
-- file adds is the rest of the contract:
--
--   * `state_postures`, versioned per state, with an exclusion constraint so that
--     "zero or multiple applicable rows fail closed" is the database's answer and
--     not a query's (9.2 step 6, Appendix G 25);
--   * `calling_windows`, the configured weekday-and-hours narrowing of the floor
--     fixed in `@fss/domain` (10.1);
--   * `dial_tickets`, the one-use 60-second ticket of 9.2;
--   * `call_logs` and `callbacks`, the outcome table of 9.1 and its effects;
--   * `suppression_finalizations`, the one-winner marker the ten-minute correction
--     and the finalizer race for (10.2, Appendix C "Event lock and terminal marker");
--   * `effective_suppressions`, the one view 10.2 makes authoritative for email and
--     for dialing;
--   * a trigger refusing a supersession that changes scope or canonical key
--     (Appendix G 21).
--
-- Seeded rows carry a named constant instant rather than now().

-- ---------------------------------------------------------------------------
-- btree_gist
--
-- The posture exclusion constraint compares a uuid and a text for equality beside
-- a range for overlap. GiST cannot index the first two without this extension, and
-- a plain UNIQUE cannot express "no two effective ranges for one state overlap".
-- It is a standard contrib module, present in PostgreSQL 16 on RDS and in the test
-- cluster; `IF NOT EXISTS` keeps the migration idempotent across the one-database-
-- per-test-file harness.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- state_postures (specification 9.2 step 6, 10.1, invariant 7)
--
-- "Exactly one applicable state posture whose effective range contains database
-- time and whose review date has not passed." The exclusion constraint is what
-- makes two applicable rows impossible rather than merely unexpected; zero rows is
-- `posture_missing` and is refused in the domain, because a table cannot require a
-- row it does not know is wanted.
--
-- Invariant 7: "Software records and enforces legal posture; it does not invent
-- it." So every row names who confirmed it, the revision of the reference texts in
-- `@fss/domain` they confirmed, which statements they confirmed, the sources they
-- read, and when it must be reviewed again. `sources` is a JSON array of titles and
-- public URLs; the quoted passages live in the domain package beside the control,
-- versioned with the release, and `rules_revision` is what ties a row to them.
--
-- A revocation is a column rather than a delete: the exclusion constraint is
-- partial on it, so a revoked posture stays readable and stops applying in one
-- statement.
-- ---------------------------------------------------------------------------
CREATE TABLE state_postures (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  state text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL,
  -- NULL is "still in force". The range below is half-open, so a posture that ends
  -- at the instant the next one begins does not overlap it.
  effective_to timestamptz,
  review_at timestamptz NOT NULL,
  rules_revision integer NOT NULL,
  confirmed_statements text[] NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by_user_id uuid NOT NULL,
  note text,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT state_postures_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT state_postures_confirmer_fkey FOREIGN KEY (workspace_id, confirmed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT state_postures_revoker_fkey FOREIGN KEY (workspace_id, revoked_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT state_postures_one_per_revision UNIQUE (workspace_id, state, revision),
  CONSTRAINT state_postures_state_shape CHECK (state ~ '^[A-Z]{2}$'),
  CONSTRAINT state_postures_revision_positive CHECK (revision >= 1),
  CONSTRAINT state_postures_rules_revision_positive CHECK (rules_revision >= 1),
  CONSTRAINT state_postures_range_ordered CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- A posture whose review date is not after the day it took effect is overdue the
  -- moment it is written, which is a recording mistake rather than a policy.
  CONSTRAINT state_postures_review_after_effective CHECK (review_at > effective_from),
  CONSTRAINT state_postures_statements_present CHECK (cardinality(confirmed_statements) > 0),
  CONSTRAINT state_postures_sources_is_array CHECK (jsonb_typeof(sources) = 'array'),
  CONSTRAINT state_postures_note_bounded
    CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 1000)),
  CONSTRAINT state_postures_revocation_consistent CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
  CONSTRAINT state_postures_revoked_not_before_created CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  -- Appendix G 25: "policy versions with zero, one, and two applicable rows fail,
  -- allow, and fail respectively". The second failure is this line.
  CONSTRAINT state_postures_no_overlap EXCLUDE USING gist (
    workspace_id WITH =,
    state WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  ) WHERE (revoked_at IS NULL)
);

CREATE INDEX state_postures_applicable
  ON state_postures (workspace_id, state, effective_from)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- calling_windows (specification 10.1, 9.2 step 7, Appendix D)
--
-- "Admins maintain versioned state postures, call windows, ..." The floor is fixed
-- in code — `CALLING_WINDOW_FLOOR` in `@fss/domain`, Monday to Friday 08:00 to
-- 20:00 on the firm's own clock — and a configured window may only narrow it. That
-- rule lives in the domain, where it can be tested without a database; what the
-- table holds is the configuration and its history.
--
-- One current window per workspace, as a partial unique index, so superseding is an
-- insert and the previous window stays readable.
-- ---------------------------------------------------------------------------
CREATE TABLE calling_windows (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  version integer NOT NULL DEFAULT 1,
  /** Minutes from local midnight, in the firm's actual zone. */
  start_minute integer NOT NULL,
  end_minute integer NOT NULL,
  /** ISO weekday numbers, 1 = Monday. A subset of the floor's Monday to Friday. */
  weekdays smallint[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5]::smallint[],
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by_user_id uuid,
  CONSTRAINT calling_windows_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT calling_windows_one_per_version UNIQUE (workspace_id, version),
  CONSTRAINT calling_windows_creator_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT calling_windows_superseder_fkey FOREIGN KEY (workspace_id, superseded_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT calling_windows_version_positive CHECK (version >= 1),
  CONSTRAINT calling_windows_start_in_day CHECK (start_minute >= 0 AND start_minute < 1440),
  CONSTRAINT calling_windows_end_in_day CHECK (end_minute > 0 AND end_minute <= 1440),
  CONSTRAINT calling_windows_ordered CHECK (end_minute > start_minute),
  CONSTRAINT calling_windows_weekdays_known
    CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  CONSTRAINT calling_windows_supersession_consistent
    CHECK ((superseded_at IS NULL) = (superseded_by_user_id IS NULL)),
  CONSTRAINT calling_windows_supersession_not_before_create
    CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

CREATE UNIQUE INDEX calling_windows_one_current
  ON calling_windows (workspace_id)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- suppression_finalizations (specification 10.2, Appendix A, Appendix C)
--
-- "At the deadline, an idempotent finalizer locks the event and enrollments and
-- performs terminal stops. A concurrent correction or finalizer has one winner."
--
-- This table *is* that winner. `suppression_events` has UPDATE revoked, so it
-- cannot be locked with `SELECT ... FOR UPDATE` — PostgreSQL requires the UPDATE
-- privilege for a row lock — and it cannot carry a status column either. So the
-- lock is an insert here: whichever of the correction and the finalizer inserts
-- first wins, the loser's `ON CONFLICT DO NOTHING` blocks until the winner commits
-- and then returns nothing, and the row afterwards says which one it was. See
-- docs/decisions/g4-finalization-is-the-lock.md.
--
-- It is also Appendix C's "terminal marker" for `suppression-finalize:{event}`: an
-- event with an `outcome = 'finalized'` row is one whose terminal stops are owed,
-- which is the signal the sequences lane subscribes to.
-- ---------------------------------------------------------------------------
CREATE TABLE suppression_finalizations (
  workspace_id uuid NOT NULL,
  event_id text NOT NULL,
  outcome text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  decided_by_user_id uuid,
  /** The correction event, when the correction won. */
  correction_event_id text,
  CONSTRAINT suppression_finalizations_pkey PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT suppression_finalizations_event_fkey FOREIGN KEY (workspace_id, event_id)
    REFERENCES suppression_events (workspace_id, event_id),
  -- DEFERRABLE INITIALLY DEFERRED, and that is load-bearing. The correction claims
  -- the decision *before* it writes the event that supersedes the original, because
  -- the claim is the serialization point: a correction that inserted its event first
  -- and then lost the race would have lifted a suppression the finalizer made
  -- terminal. Naming an event that does not exist yet is only legal until commit,
  -- which is exactly the window the claim needs.
  CONSTRAINT suppression_finalizations_correction_fkey FOREIGN KEY (workspace_id, correction_event_id)
    REFERENCES suppression_events (workspace_id, event_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT suppression_finalizations_decider_fkey FOREIGN KEY (workspace_id, decided_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT suppression_finalizations_outcome_known CHECK (outcome IN ('finalized', 'corrected')),
  -- A correction names the event that superseded the original; a finalization does
  -- not, because nothing superseded anything.
  CONSTRAINT suppression_finalizations_correction_consistent
    CHECK ((outcome = 'corrected') = (correction_event_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- A supersession may not change the scope or the canonical key (10.2, Appendix G 21)
--
-- "At most one direct supersession may reference an event with the same workspace,
-- scope, and canonical key." Migration 0001 gave the first half — one direct
-- supersession per event — as a partial unique index. This is the second half, and
-- it has to be a trigger because a CHECK cannot read another row.
--
-- Written as a BEFORE trigger so the refusal names this constraint rather than
-- landing as a foreign-key error later in the statement.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_supersession_same_key() RETURNS trigger
LANGUAGE plpgsql AS $supersession$
DECLARE
  original suppression_events%ROWTYPE;
BEGIN
  IF NEW.supersedes_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original
    FROM suppression_events
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.supersedes_event_id;
  IF NOT FOUND THEN
    -- The composite foreign key reports this one; nothing to add.
    RETURN NEW;
  END IF;
  IF original.scope <> NEW.scope OR original.canonical_key <> NEW.canonical_key THEN
    RAISE EXCEPTION
      'a supersession names the same scope and canonical key as the event it supersedes'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'suppression_events_supersession_same_key';
  END IF;
  RETURN NEW;
END
$supersession$;

CREATE TRIGGER suppression_events_supersession_same_key
  BEFORE INSERT ON suppression_events
  FOR EACH ROW EXECUTE FUNCTION assert_supersession_same_key();

-- ---------------------------------------------------------------------------
-- effective_suppressions (specification 10.2)
--
-- "One `effective_suppressions` view is authoritative for email and dialing."
--
-- An event is effective when nothing directly supersedes it. A supersession row is
-- never itself a suppression: it is the record of one being lifted, which is why
-- `supersedes_event_id IS NULL` is the first predicate rather than a filter on the
-- source.
--
-- One row per (workspace, scope, canonical key), carrying the *earliest* effective
-- event, so a caller asks "is this key suppressed" with a lookup and gets the event
-- that first made it so. Provenance for the rest is a query against the table.
--
-- A manual suppression inside its ten-minute correction window is in here: section
-- 10.2 says it "is also effective immediately", and Appendix G 29's "never contact
-- during the window" is exactly that sentence.
-- ---------------------------------------------------------------------------
CREATE VIEW effective_suppressions AS
SELECT DISTINCT ON (e.workspace_id, e.scope, e.canonical_key)
       e.workspace_id,
       e.scope,
       e.canonical_key,
       e.event_id,
       e.canonicalizer_version,
       e.source,
       e.actor_user_id,
       e.recorded_at
  FROM suppression_events e
 WHERE e.supersedes_event_id IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM suppression_events s
      WHERE s.workspace_id = e.workspace_id
        AND s.supersedes_event_id = e.event_id
   )
 ORDER BY e.workspace_id, e.scope, e.canonical_key, e.recorded_at, e.event_id;

-- ---------------------------------------------------------------------------
-- dial_tickets (specification 9.2, 5.3)
--
-- "The command creates a one-use ticket recording database time, route and posture
-- versions, actor, device, assignment, and identity, valid for 60 seconds."
--
-- Every one of those is a column, and `expires_at` is computed from the database's
-- clock by the command rather than sent by a caller, so a client cannot mint itself
-- a longer one.
--
-- `UNIQUE (workspace_id, command_id)` is the other half of "command replay returns
-- `already_consumed`, never another allow": the API's command receipt answers a
-- replay that reaches it, and this refuses a second ticket for the same command id
-- even if one did not.
-- ---------------------------------------------------------------------------
CREATE TABLE dial_tickets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  command_id text NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  phone_route_id uuid NOT NULL,
  route_version integer NOT NULL,
  posture_id uuid NOT NULL,
  posture_revision integer NOT NULL,
  calling_identity_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  /** The assignment the decision rested on, recorded so a later reassignment is visible. */
  assigned_user_id uuid NOT NULL,
  e164 text NOT NULL,
  firm_time_zone text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT dial_tickets_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT dial_tickets_one_per_command UNIQUE (workspace_id, command_id),
  CONSTRAINT dial_tickets_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT dial_tickets_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT dial_tickets_route_fkey FOREIGN KEY (workspace_id, phone_route_id)
    REFERENCES phone_routes (workspace_id, id),
  CONSTRAINT dial_tickets_posture_fkey FOREIGN KEY (workspace_id, posture_id)
    REFERENCES state_postures (workspace_id, id),
  CONSTRAINT dial_tickets_identity_fkey FOREIGN KEY (workspace_id, calling_identity_id)
    REFERENCES calling_identities (workspace_id, id),
  CONSTRAINT dial_tickets_actor_fkey FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT dial_tickets_assignee_fkey FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT dial_tickets_device_fkey FOREIGN KEY (workspace_id, device_id)
    REFERENCES devices (workspace_id, id),
  CONSTRAINT dial_tickets_command_id_shape CHECK (command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  CONSTRAINT dial_tickets_route_version_positive CHECK (route_version >= 1),
  CONSTRAINT dial_tickets_posture_revision_positive CHECK (posture_revision >= 1),
  CONSTRAINT dial_tickets_e164_shape CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT dial_tickets_zone_shape
    CHECK (firm_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  -- Sixty seconds, from 9.2. A ticket that outlived its minute is refused by the
  -- consumption statement; this refuses one that was never a minute long.
  CONSTRAINT dial_tickets_expiry_after_issue
    CHECK (expires_at > issued_at AND expires_at <= issued_at + INTERVAL '60 seconds'),
  CONSTRAINT dial_tickets_consumed_within_life
    CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at <= expires_at))
);

CREATE INDEX dial_tickets_unconsumed
  ON dial_tickets (workspace_id, expires_at)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- call_logs (specification 9.1, Appendix A "Log call outcome", Appendix F)
--
-- "Call logging always records what occurred, even if no valid ticket exists; it
-- never refuses history." So `ticket_id`, `phone_route_id` and `calling_identity_id`
-- are all nullable: a call placed from a phone that FSS never authorized is still a
-- call that happened, and the history is worth more than the tidiness.
--
-- `step_effect` is the hook the sequences lane reads. Section 9.1 gives each outcome
-- an effect on the step — "complete the call step and create its configured
-- successor", "follow the step's configured advance | retry_call behavior", "do not
-- complete the step" — and no enrollment table exists yet, so the decided effect is
-- recorded here rather than applied. `step_execution_id` is the column that lane
-- fills in.
--
-- `note` is Appendix F's second row: "call outcomes without notes" are visible to any
-- active member, the note is not. The DTOs enforce that; the column carries it.
-- ---------------------------------------------------------------------------
CREATE TABLE call_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  opportunity_id uuid,
  phone_route_id uuid,
  calling_identity_id uuid,
  ticket_id uuid,
  step_execution_id uuid,
  outcome text NOT NULL,
  step_effect text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid NOT NULL,
  command_id text,
  note text,
  CONSTRAINT call_logs_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT call_logs_one_per_command UNIQUE (workspace_id, command_id),
  CONSTRAINT call_logs_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT call_logs_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT call_logs_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT call_logs_route_fkey FOREIGN KEY (workspace_id, phone_route_id)
    REFERENCES phone_routes (workspace_id, id),
  CONSTRAINT call_logs_identity_fkey FOREIGN KEY (workspace_id, calling_identity_id)
    REFERENCES calling_identities (workspace_id, id),
  CONSTRAINT call_logs_ticket_fkey FOREIGN KEY (workspace_id, ticket_id)
    REFERENCES dial_tickets (workspace_id, id),
  CONSTRAINT call_logs_actor_fkey FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT call_logs_outcome_known
    CHECK (outcome IN ('interested', 'referral_or_wrong_person', 'callback_requested', 'not_interested',
                       'do_not_call', 'wrong_number', 'voicemail_left', 'no_answer', 'busy',
                       'policy_or_technical_failure')),
  CONSTRAINT call_logs_step_effect_known
    CHECK (step_effect IN ('complete_and_advance', 'advance', 'retry_call', 'none')),
  CONSTRAINT call_logs_command_id_shape CHECK (command_id IS NULL OR command_id ~ '^[0-9a-zA-Z_:-]{1,128}$'),
  CONSTRAINT call_logs_note_bounded CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 2000)),
  CONSTRAINT call_logs_recorded_not_before_occurred CHECK (recorded_at >= occurred_at)
);

CREATE INDEX call_logs_by_firm ON call_logs (workspace_id, firm_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- callbacks (specification 9.1, 8.2, Appendix D)
--
-- "Callback requested — set manual and create a callback after salesperson
-- confirmation of the instant." The confirmation is the point: an instant an LLM or
-- a prose parser proposed is never committed by itself (12.4), so a row exists only
-- once a person confirmed it, and `confirmed_at` records when.
--
-- Appendix D: "Requested local date/time, source zone, resolved UTC instant, all
-- stored." All four are columns, because a callback re-rendered from the UTC instant
-- alone would drift across a zone change or a DST boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE callbacks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  opportunity_id uuid,
  call_log_id uuid,
  assigned_user_id uuid NOT NULL,
  requested_local_date date NOT NULL,
  requested_local_time time,
  source_time_zone text NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open',
  confirmed_at timestamptz NOT NULL,
  confirmed_by_user_id uuid NOT NULL,
  completed_at timestamptz,
  completed_by_user_id uuid,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT callbacks_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT callbacks_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT callbacks_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT callbacks_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT callbacks_call_log_fkey FOREIGN KEY (workspace_id, call_log_id)
    REFERENCES call_logs (workspace_id, id),
  CONSTRAINT callbacks_assignee_fkey FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT callbacks_confirmer_fkey FOREIGN KEY (workspace_id, confirmed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT callbacks_completer_fkey FOREIGN KEY (workspace_id, completed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT callbacks_status_known CHECK (status IN ('open', 'completed', 'cancelled')),
  CONSTRAINT callbacks_zone_shape
    CHECK (source_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  CONSTRAINT callbacks_completion_consistent
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)
           AND (completed_at IS NULL) = (completed_by_user_id IS NULL)),
  CONSTRAINT callbacks_cancellation_consistent
    CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL)),
  CONSTRAINT callbacks_cancelled_reason_bounded
    CHECK (cancelled_reason IS NULL OR (btrim(cancelled_reason) <> '' AND length(cancelled_reason) <= 300)),
  CONSTRAINT callbacks_completed_not_before_created CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX callbacks_open_by_owner
  ON callbacks (workspace_id, assigned_user_id, due_at)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then. `suppression_finalizations` is append-only for the same reason
-- `suppression_events` is: the winner of the race is a fact about what happened,
-- and a second writer must not be able to rewrite it into a different answer.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON state_postures TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON calling_windows TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON dial_tickets TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_logs TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON callbacks TO app_runtime, migration;

GRANT SELECT, INSERT ON suppression_finalizations TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON suppression_finalizations FROM app_runtime, migration;

GRANT SELECT ON effective_suppressions TO app_runtime, migration;
