-- 0013_dashboard
--
-- Administrative configuration, versioned with a change history (specification
-- revision 3: sections 10.1, 13.3 "Initial alarm thresholds are configuration,
-- versioned with the release", 13.4, 16.2, and Appendix D). Forward-only; this file
-- never changes once it has been applied anywhere. See docs/greenfield/migrations.md.
--
-- One table. That is the surprise in a migration called `dashboard`, so it is worth
-- saying plainly: **the minimum performance dashboard of 13.4 needs no table of its
-- own.** Every figure it shows is an aggregate over rows some other lane already
-- writes — `mail_messages` and their classifications, `call_logs`,
-- `opportunity_stage_events`, `active_holds`, `today_items`, `daily_counters`,
-- `suppression_events`, and the sending and enrollment tables that arrive with G7-2
-- and G8. A summary table would be a second copy of those facts that can disagree
-- with them, and version one's traffic is "modest and predictable" (section 1). When
-- a query is measured to be too slow, the fix is an index or a materialized view over
-- the same rows, not a parallel truth.
--
-- What does need a table is configuration, because 13.3 asks for it to be versioned
-- and 10.1 asks for a change history, and neither is derivable from anything.
--
-- ---------------------------------------------------------------------------
-- What is deliberately NOT in here
-- ---------------------------------------------------------------------------
--
-- State postures, calling windows, research settings, providers, route-eligibility
-- thresholds, template approval, memberships, devices, calling identities and
-- mailboxes are configuration too. Each already has its own table, its own
-- versioning and its own commands, written by the lane that owns the behaviour. They
-- are not copied here. A workspace with two answers for "what is the calling window"
-- is worse than one with an awkward settings page, and the awkwardness is solved in
-- the API by reading each of them through its own endpoint.
--
-- The workspace business zone is the one overlap, and it is deliberate:
-- `workspaces.business_time_zone` stays the single value every query reads, and the
-- setting row beside it is the *history* of how it came to be that value. The command
-- writes both in one transaction; see packages/domain/settings/store.ts.

-- ---------------------------------------------------------------------------
-- workspace_settings (10.1, 13.3, 16.2)
--
-- Append-mostly: a change inserts a new version and marks the previous one
-- superseded. Nothing is ever edited in place except the supersession columns of the
-- row being retired, so "who changed the sending limit, when, from what, and why" is
-- a select rather than an archaeology exercise.
--
-- The value is `jsonb` and the shape is checked by the key's schema in
-- `@fss/contracts` rather than by a column per field. That is the right trade here
-- and it is worth being explicit about why: these are release-versioned operator
-- knobs, not business records that other tables reference. A column per threshold
-- would make every threshold change a migration, and 13.3 says they are
-- configuration. Nothing in the database joins to a setting's contents, so the
-- database's usual objection to a JSON blob does not apply.
--
-- The key set is a CHECK rather than a foreign key to a vocabulary table, following
-- `docs/decisions/g0-database-conventions.md`: it is small, closed and visible in the
-- table definition, and a test compares it with the `SETTING_KEYS` enum row for row.
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  setting_key text NOT NULL,
  version integer NOT NULL,
  value jsonb NOT NULL,
  change_note text,
  -- Null for a row written by the system (a seed, a data migration). A user who is
  -- later removed keeps their membership row, so this reference stays valid.
  changed_by_user_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  superseded_by_version integer,

  CONSTRAINT workspace_settings_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_settings_one_per_version UNIQUE (workspace_id, setting_key, version),
  CONSTRAINT workspace_settings_actor_fkey FOREIGN KEY (workspace_id, changed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),

  -- The closed set of 10.1's configuration slices this table owns. Keep it equal to
  -- SETTING_KEYS in packages/contracts/src/settings.ts; a test asserts it.
  CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('alert_thresholds', 'business_time_zone', 'client_version_range',
                           'holiday_calendar', 'postal_footer', 'sending_enabled', 'sending_limits')),
  CONSTRAINT workspace_settings_version_positive CHECK (version >= 1),
  CONSTRAINT workspace_settings_value_is_object CHECK (jsonb_typeof(value) = 'object'),
  CONSTRAINT workspace_settings_note_bounded
    CHECK (change_note IS NULL OR (btrim(change_note) <> '' AND length(change_note) <= 500)),
  -- A retired row names its successor and a current row names neither. The two
  -- columns cannot disagree about whether this version is still in force.
  CONSTRAINT workspace_settings_supersession_consistent
    CHECK ((superseded_at IS NULL) = (superseded_by_version IS NULL)),
  CONSTRAINT workspace_settings_superseded_by_later
    CHECK (superseded_by_version IS NULL OR superseded_by_version > version),
  CONSTRAINT workspace_settings_superseded_not_before_changed
    CHECK (superseded_at IS NULL OR superseded_at >= changed_at)
);

-- At most one current version per key per workspace. This is the invariant the whole
-- table exists to hold: "what is the sending limit" has one answer. The update
-- command additionally takes a transaction advisory lock on (workspace, key), so two
-- admins saving at the same instant queue rather than collide with this index — a
-- unique violation would abort the transaction and take the command receipt with it.
CREATE UNIQUE INDEX workspace_settings_current
  ON workspace_settings (workspace_id, setting_key)
  WHERE superseded_at IS NULL;

-- The history read: every version of one key, newest first.
CREATE INDEX workspace_settings_history
  ON workspace_settings (workspace_id, setting_key, version DESC);

-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then. UPDATE is granted because retiring a version writes the supersession columns
-- of the row being retired; DELETE is granted for the ordinary workspace-deletion
-- path and is never used by the settings commands.
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_settings TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- Dashboard read paths
--
-- No table, but two indexes the 13.4 aggregates need and that no existing index
-- covers. Both are over columns other lanes own; adding an index is additive and
-- changes no behaviour of theirs.
-- ---------------------------------------------------------------------------

-- "hold counts, age, and reasons": the dashboard groups open holds by reason code.
-- The existing indexes on active_holds are for the eligibility reads, which look up
-- by scope; this one is for the count.
CREATE INDEX active_holds_open_by_reason
  ON active_holds (workspace_id, reason_code, started_at)
  WHERE released_at IS NULL;

-- "calls and outcomes" over a date range. `call_logs_by_firm` is ordered by firm
-- first and cannot serve a workspace-wide window.
CREATE INDEX call_logs_by_occurred_at
  ON call_logs (workspace_id, occurred_at DESC, outcome);
