-- ---------------------------------------------------------------------------
-- 0028_call_to_booking.sql — the call-to-booking walking skeleton (slice W)
-- changes: pipeline_stages, opportunities, opportunity_stage_events, provider_reservations, workspace_settings
--
-- The call-to-booking milestone (PLAN-20260930-call-to-booking, 30 September 2026):
-- a researched firm → a call session placed through Twilio → a recorded outcome → an
-- eligible follow-up → a Cal.com booking → an automatic pipeline move. Every new
-- behaviour sits behind two workspace settings that default off (`calling_provider =
-- tel`, `calendar_integration = off`); the one change a person sees with the flags off
-- is the stage relabel below, which is intended.
--
-- ## What `-- changes:` names, and why each
--
--   (a) `pipeline_stages` — the Kanban's five columns. `new`, `qualified`, `won` and
--       `lost` keep their keys and are relabelled Interested, Decision pending, Live and
--       Lost; `demo_booked` and `onboarding` are added; `contacting`, `engaged` and
--       `proposal` are retired (retired stages stay readable, 8.1). Every workspace is
--       renumbered: new, demo_booked, qualified, onboarding, any stage an admin added,
--       the retired stages, then won and lost — contiguous from 1, terminal last, the
--       invariant `crm/stageAdmin.ts` keeps. `new` and `qualified` are un-retired if an
--       admin had retired either, because the board's columns are these keys.
--   (b) `opportunities` — every OPEN opportunity in `contacting` or `engaged` moves to
--       `new`, and every open one in `proposal` to `qualified`. Closed opportunities are
--       never touched: their stage is their history.
--   (c) `opportunity_stage_events` — one row per move in (b), actor `system`, reason
--       `stage_remap_20260930`, so the firm page's stage history says what happened.
--   (d) `provider_reservations` — telephony subjects. `subject_known` admits
--       `call_session` and `call_transcription` (a swap under the same name); the three
--       model/token snapshot columns become nullable and a CHECK by subject kind makes
--       them required for `research_run` exactly as before; three telephony snapshot
--       columns (`priced_unit`, `max_units`, `unit_price_micros`) are added, required
--       for the telephony subjects and forbidden for the LLM one. Every stored row is a
--       `research_run` with all three model fields present, so every existing CHECK
--       answer is unchanged and the new CHECK is satisfied by every existing row.
--   (e) `workspace_settings` — `workspace_settings_key_known` admits the three new
--       keys (`calling_provider`, `calendar_integration`, `telephony_budget`); a swap
--       under the same name, as 0020's was. No row is written: a key with no row is
--       its default (`DEFAULT_SETTING_VALUES`), and every default is "off".
--
-- `seed_default_pipeline_stages` is replaced (CREATE OR REPLACE) so a workspace
-- created from now on is seeded with the new set; the trigger that calls it is
-- unchanged.
--
-- ## The new tables
--
--   * `opportunity_values` — monthly value in cents, append-only; the current value is
--     the latest row. `estimated` or `agreed`.
--   * `stage_rules` — evidence kind → target stage key, a global vocabulary seeded
--     below. Read by `applyStageEvidence` (`crm/stageEvidence.ts`).
--   * `opportunity_stage_evidence` — the evidence an automatic move rested on, one row
--     per stage event it caused. Append-only.
--   * `opportunity_stage_pins` — present while a person's manual stage choice stands.
--     Only evidence for a LATER stage moves a pinned opportunity, and it clears the pin.
--     Backfilled below from the last stage event of every open opportunity, when that
--     event was a person's move.
--   * `stage_review_items` — evidence that could not be applied without a person:
--     a closed opportunity, an unmatched meeting, a stage that does not exist.
--   * `call_sessions` — one Twilio call attempt, bound to one dial ticket.
--   * `calcom_events` — every verified Cal.com delivery, keyed by the sha256 of its
--     raw body, so an exact redelivery is one row.
--   * `meetings` — one Cal.com booking and its state machine, ordered by the payload
--     timestamp of the last event applied.
--   * `mail_message_duplicates` — provider message ids the mail pipeline will not
--     import (a proven duplicate, or vanished); for the mail slice.
--
-- ## Release shape
--
-- `touches-existing` (the UPDATEs and INSERTs on (a)–(c), the ALTERs on (d) and (e)) and
-- `replaces-routine` (the seed function). Both services move to schema 28 together;
-- `stop, apply, deploy` as every schema release since 0006. The UPDATEs touch the open
-- opportunities of three stages and every stage row — small tables, one transaction.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (a) pipeline_stages
-- ---------------------------------------------------------------------------

-- The new default set, for every workspace created from now on. `ON CONFLICT DO
-- NOTHING` as before, so a re-seed never fails on a key that is already there.
CREATE OR REPLACE FUNCTION seed_default_pipeline_stages(target_workspace uuid, seeded_at timestamptz) RETURNS void
LANGUAGE sql AS $stages$
  INSERT INTO pipeline_stages (workspace_id, key, display_name, position, terminal_kind, created_at, updated_at)
  VALUES
    (target_workspace, 'new',         'Interested',       1, NULL,   seeded_at, seeded_at),
    (target_workspace, 'demo_booked', 'Demo booked',      2, NULL,   seeded_at, seeded_at),
    (target_workspace, 'qualified',   'Decision pending', 3, NULL,   seeded_at, seeded_at),
    (target_workspace, 'onboarding',  'Onboarding',       4, NULL,   seeded_at, seeded_at),
    (target_workspace, 'won',         'Live',             5, 'won',  seeded_at, seeded_at),
    (target_workspace, 'lost',        'Lost',             6, 'lost', seeded_at, seeded_at)
  ON CONFLICT ON CONSTRAINT pipeline_stages_key_unique DO NOTHING;
$stages$;

-- The two new columns for every existing workspace, parked beyond every position in
-- use; the renumbering below puts them where they belong. A named constant instant,
-- never now().
INSERT INTO pipeline_stages (workspace_id, key, display_name, position, terminal_kind, created_at, updated_at)
SELECT w.id, added.key, added.display_name,
       1000 + added.ordinal + COALESCE((SELECT max(s.position) FROM pipeline_stages s WHERE s.workspace_id = w.id), 0),
       NULL, TIMESTAMPTZ '2026-09-30 00:00:00+00', TIMESTAMPTZ '2026-09-30 00:00:00+00'
  FROM workspaces w
 CROSS JOIN (VALUES ('demo_booked', 'Demo booked', 1), ('onboarding', 'Onboarding', 2)) AS added(key, display_name, ordinal)
ON CONFLICT ON CONSTRAINT pipeline_stages_key_unique DO NOTHING;

-- Relabel, retire and renumber in one statement. `pipeline_stages_position_unique` is
-- DEFERRABLE, so it is checked at the end of the statement rather than row by row, and
-- a permutation of positions is one UPDATE.
UPDATE pipeline_stages AS s
   SET display_name = CASE s.key
                        WHEN 'new' THEN 'Interested'
                        WHEN 'qualified' THEN 'Decision pending'
                        WHEN 'won' THEN 'Live'
                        WHEN 'lost' THEN 'Lost'
                        ELSE s.display_name
                      END,
       retired = CASE
                   WHEN s.key IN ('contacting', 'engaged', 'proposal') AND s.terminal_kind IS NULL THEN true
                   WHEN s.key IN ('new', 'demo_booked', 'qualified', 'onboarding') AND s.terminal_kind IS NULL THEN false
                   ELSE s.retired
                 END,
       position = ordered.position,
       updated_at = GREATEST(s.updated_at, TIMESTAMPTZ '2026-09-30 00:00:00+00')
  FROM (
    SELECT id, workspace_id,
           row_number() OVER (
             PARTITION BY workspace_id
             ORDER BY CASE
                        WHEN terminal_kind = 'won' THEN 5
                        WHEN terminal_kind = 'lost' THEN 6
                        WHEN key IN ('new', 'demo_booked', 'qualified', 'onboarding') THEN 1
                        WHEN key IN ('contacting', 'engaged', 'proposal') OR retired THEN 3
                        ELSE 2
                      END,
                      CASE key WHEN 'new' THEN 1 WHEN 'demo_booked' THEN 2 WHEN 'qualified' THEN 3 WHEN 'onboarding' THEN 4 ELSE 5 END,
                      position,
                      id
           )::integer AS position
      FROM pipeline_stages
  ) AS ordered
 WHERE s.workspace_id = ordered.workspace_id AND s.id = ordered.id;

-- ---------------------------------------------------------------------------
-- opportunity_stage_pins — a person's manual stage choice, while it stands
--
-- One row per pinned opportunity, deleted when later-stage evidence moves it or when
-- the opportunity closes. The row's `stage_id` is the stage the person chose;
-- `source_event_id` is the stage event that recorded the choice.
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_stage_pins (
  workspace_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  pinned_by_user_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  pinned_at timestamptz NOT NULL,
  CONSTRAINT opportunity_stage_pins_pkey PRIMARY KEY (workspace_id, opportunity_id),
  CONSTRAINT opportunity_stage_pins_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT opportunity_stage_pins_stage_fkey FOREIGN KEY (workspace_id, stage_id)
    REFERENCES pipeline_stages (workspace_id, id),
  CONSTRAINT opportunity_stage_pins_event_fkey FOREIGN KEY (workspace_id, source_event_id)
    REFERENCES opportunity_stage_events (workspace_id, id),
  CONSTRAINT opportunity_stage_pins_user_fkey FOREIGN KEY (workspace_id, pinned_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id)
);

-- The backfill, BEFORE the remap writes its system events: an open opportunity is
-- pinned when the last event of its stage history is a person's move (from one stage
-- to another, not the opening row). The pinned stage is the one the remap below puts
-- it in, so a person who chose Engaged is pinned at Interested — the same column.
INSERT INTO opportunity_stage_pins
  (workspace_id, opportunity_id, firm_id, stage_id, pinned_by_user_id, source_event_id, pinned_at)
SELECT o.workspace_id, o.id, o.firm_id,
       COALESCE(target.id, o.stage_id),
       last.actor_user_id, last.id, last.occurred_at
  FROM opportunities o
  JOIN LATERAL (
    SELECT e.id, e.actor_kind, e.actor_user_id, e.from_stage_id, e.occurred_at
      FROM opportunity_stage_events e
     WHERE e.workspace_id = o.workspace_id AND e.opportunity_id = o.id
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT 1
  ) AS last ON true
  JOIN pipeline_stages cur ON cur.workspace_id = o.workspace_id AND cur.id = o.stage_id
  LEFT JOIN pipeline_stages target
    ON target.workspace_id = o.workspace_id
   AND target.key = CASE cur.key WHEN 'proposal' THEN 'qualified' WHEN 'contacting' THEN 'new' WHEN 'engaged' THEN 'new' END
 WHERE o.status = 'open'
   AND last.actor_kind IN ('user', 'admin')
   AND last.actor_user_id IS NOT NULL
   AND last.from_stage_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- (b) and (c) the remap of open opportunities, with its events
--
-- The events first, reading the opportunities as they are; then the move. The event's
-- instant is the named constant, or a millisecond after the opportunity's last event
-- when that is later, so the history stays in order.
-- ---------------------------------------------------------------------------
INSERT INTO opportunity_stage_events
  (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id, reason, command_id, occurred_at)
SELECT o.workspace_id, o.id, o.firm_id, cur.id, target.id, 'system', NULL, 'stage_remap_20260930', NULL,
       GREATEST(
         TIMESTAMPTZ '2026-09-30 00:00:00+00',
         COALESCE((SELECT max(e.occurred_at) FROM opportunity_stage_events e
                    WHERE e.workspace_id = o.workspace_id AND e.opportunity_id = o.id), TIMESTAMPTZ '2026-09-30 00:00:00+00')
           + INTERVAL '1 millisecond'
       )
  FROM opportunities o
  JOIN pipeline_stages cur ON cur.workspace_id = o.workspace_id AND cur.id = o.stage_id
  JOIN pipeline_stages target
    ON target.workspace_id = o.workspace_id
   AND target.key = CASE cur.key WHEN 'proposal' THEN 'qualified' ELSE 'new' END
 WHERE o.status = 'open'
   AND cur.key IN ('contacting', 'engaged', 'proposal');

UPDATE opportunities AS o
   SET stage_id = target.id,
       updated_at = GREATEST(o.updated_at, TIMESTAMPTZ '2026-09-30 00:00:00+00')
  FROM pipeline_stages cur, pipeline_stages target
 WHERE o.status = 'open'
   AND cur.workspace_id = o.workspace_id AND cur.id = o.stage_id
   AND cur.key IN ('contacting', 'engaged', 'proposal')
   AND target.workspace_id = o.workspace_id
   AND target.key = CASE cur.key WHEN 'proposal' THEN 'qualified' ELSE 'new' END;

-- ---------------------------------------------------------------------------
-- opportunity_values — monthly value in cents, append-only; the latest row is current
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_values (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  monthly_cents integer NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  recorded_by_user_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_values_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT opportunity_values_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT opportunity_values_recorder_fkey FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  -- Up to a million dollars a month, which is a typo guard rather than a business rule.
  CONSTRAINT opportunity_values_cents_bounded CHECK (monthly_cents >= 0 AND monthly_cents <= 100000000),
  CONSTRAINT opportunity_values_kind_known CHECK (kind IN ('estimated', 'agreed')),
  CONSTRAINT opportunity_values_source_shape CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$')
);

CREATE INDEX opportunity_values_latest ON opportunity_values (workspace_id, opportunity_id, recorded_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- stage_rules — which evidence moves an opportunity where
--
-- A global vocabulary, like `hold_reason_codes`: the stage KEYS are the same in every
-- workspace, and a workspace without the target key gets a review item instead of a
-- move. `advance` moves an open opportunity forward to the target; `open_if_none`
-- opens one at the target when the firm has no opportunity at all (the existing
-- interested-call path, `dial/calls.ts`). `subscription.accepted` and `customer.live`
-- have no emitter yet; their rows are here so the emitter that comes next adds no
-- migration.
-- ---------------------------------------------------------------------------
CREATE TABLE stage_rules (
  evidence_kind text NOT NULL,
  action text NOT NULL,
  target_stage_key text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT stage_rules_pkey PRIMARY KEY (evidence_kind),
  CONSTRAINT stage_rules_evidence_kind_shape CHECK (evidence_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(evidence_kind) <= 64),
  CONSTRAINT stage_rules_action_known CHECK (action IN ('advance', 'open_if_none')),
  CONSTRAINT stage_rules_target_key_shape CHECK (target_stage_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT stage_rules_description_present CHECK (btrim(description) <> '' AND length(description) <= 300)
);

INSERT INTO stage_rules (evidence_kind, action, target_stage_key, description, created_at) VALUES
  ('meeting.booked', 'advance', 'demo_booked', 'A Cal.com booking with this firm moves its opportunity to Demo booked.', TIMESTAMPTZ '2026-09-30 00:00:00+00'),
  ('call.interested', 'open_if_none', 'new', 'An interested call opens the firm''s opportunity in Interested when it has none.', TIMESTAMPTZ '2026-09-30 00:00:00+00'),
  ('subscription.accepted', 'advance', 'onboarding', 'An accepted subscription moves the opportunity to Onboarding. No emitter yet.', TIMESTAMPTZ '2026-09-30 00:00:00+00'),
  ('customer.live', 'advance', 'won', 'A live customer moves the opportunity to Live. No emitter yet.', TIMESTAMPTZ '2026-09-30 00:00:00+00');

-- ---------------------------------------------------------------------------
-- opportunity_stage_evidence — what an automatic move rested on. Append-only.
--
-- One row per stage event an automatic move wrote. `(opportunity, kind, evidence id)`
-- is unique, so the same evidence applied twice moves once.
-- ---------------------------------------------------------------------------
CREATE TABLE opportunity_stage_evidence (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  stage_event_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  evidence_kind text NOT NULL,
  evidence_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_stage_evidence_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT opportunity_stage_evidence_one_per_event UNIQUE (workspace_id, stage_event_id),
  CONSTRAINT opportunity_stage_evidence_once UNIQUE (workspace_id, opportunity_id, evidence_kind, evidence_id),
  CONSTRAINT opportunity_stage_evidence_event_fkey FOREIGN KEY (workspace_id, stage_event_id)
    REFERENCES opportunity_stage_events (workspace_id, id),
  CONSTRAINT opportunity_stage_evidence_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT opportunity_stage_evidence_rule_fkey FOREIGN KEY (evidence_kind) REFERENCES stage_rules (evidence_kind),
  CONSTRAINT opportunity_stage_evidence_id_shape CHECK (evidence_id ~ '^[0-9a-zA-Z_:.-]{1,200}$'),
  CONSTRAINT opportunity_stage_evidence_detail_bounded
    CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000)
);

-- ---------------------------------------------------------------------------
-- stage_review_items — evidence a person has to look at instead of a move
-- ---------------------------------------------------------------------------
CREATE TABLE stage_review_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  firm_id uuid,
  opportunity_id uuid,
  evidence_kind text NOT NULL,
  evidence_id text NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid,
  CONSTRAINT stage_review_items_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT stage_review_items_once UNIQUE (workspace_id, evidence_kind, evidence_id),
  CONSTRAINT stage_review_items_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT stage_review_items_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT stage_review_items_resolver_fkey FOREIGN KEY (workspace_id, resolved_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT stage_review_items_kind_shape CHECK (evidence_kind ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' AND length(evidence_kind) <= 64),
  CONSTRAINT stage_review_items_id_shape CHECK (evidence_id ~ '^[0-9a-zA-Z_:.-]{1,200}$'),
  CONSTRAINT stage_review_items_reason_known
    CHECK (reason IN ('opportunity_closed', 'no_opportunity', 'stage_missing', 'rule_missing',
                      'firm_unmatched', 'firm_ambiguous')),
  -- An opportunity names its firm (the composite key above only binds when both are set).
  CONSTRAINT stage_review_items_opportunity_has_firm CHECK (opportunity_id IS NULL OR firm_id IS NOT NULL),
  CONSTRAINT stage_review_items_resolution_consistent
    CHECK ((resolved_at IS NULL) = (resolved_by_user_id IS NULL)),
  CONSTRAINT stage_review_items_detail_bounded
    CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 2000)
);

CREATE INDEX stage_review_items_open ON stage_review_items (workspace_id, created_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- (d) provider_reservations — telephony subjects
-- ---------------------------------------------------------------------------
ALTER TABLE provider_reservations
  ALTER COLUMN model_name DROP NOT NULL,
  ALTER COLUMN max_input_tokens DROP NOT NULL,
  ALTER COLUMN max_output_tokens DROP NOT NULL,
  ADD COLUMN priced_unit text,
  ADD COLUMN max_units integer,
  ADD COLUMN unit_price_micros integer,
  DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known
    CHECK (subject_kind IN ('research_run', 'call_session', 'call_transcription')),
  -- The priced shape these cents were computed from, by subject kind: a model and two
  -- token bounds for the LLM subject (exactly what 0023 required of every row), a unit,
  -- a unit count and a unit price for the telephony subjects — and never the other's.
  -- An unknown subject passes this one and is refused by `subject_known`, which is the
  -- constraint that is about it.
  ADD CONSTRAINT provider_reservations_priced_shape
    CHECK (
      (subject_kind <> 'research_run'
        OR (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL
            AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
      AND
      (subject_kind NOT IN ('call_session', 'call_transcription')
        OR (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL
            AND priced_unit IS NOT NULL AND priced_unit = 'minute' AND max_units IS NOT NULL AND max_units > 0 AND max_units <= 240
            AND unit_price_micros IS NOT NULL AND unit_price_micros >= 0 AND unit_price_micros <= 10000000))
    );

-- ---------------------------------------------------------------------------
-- call_sessions — one Twilio call attempt, bound to one dial ticket
--
-- Created by `POST /calls/session` with its ticket and its reservation, valid for the
-- ticket's sixty seconds. The TwiML route consumes it once, recording the Call SID;
-- the status and recording callbacks update it by that SID. The dialled number is on
-- the ticket, never here and never on the wire to the renderer.
-- ---------------------------------------------------------------------------
CREATE TABLE call_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid,
  actor_user_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'authorized',
  provider_status text,
  twilio_call_sid text,
  dial_call_sid text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_sid text,
  recording_path text,
  recording_duration_seconds integer,
  billed_price_cents integer,
  call_log_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_sessions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT call_sessions_one_per_ticket UNIQUE (workspace_id, ticket_id),
  -- Twilio's SIDs are globally unique, and the callbacks carry no workspace.
  CONSTRAINT call_sessions_call_sid_unique UNIQUE (twilio_call_sid),
  CONSTRAINT call_sessions_ticket_fkey FOREIGN KEY (workspace_id, ticket_id) REFERENCES dial_tickets (workspace_id, id),
  CONSTRAINT call_sessions_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT call_sessions_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT call_sessions_actor_fkey FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT call_sessions_reservation_fkey FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES provider_reservations (workspace_id, id),
  CONSTRAINT call_sessions_call_log_fkey FOREIGN KEY (workspace_id, call_log_id) REFERENCES call_logs (workspace_id, id),
  CONSTRAINT call_sessions_status_known
    CHECK (status IN ('authorized', 'ringing', 'in_progress', 'completed', 'failed', 'canceled')),
  CONSTRAINT call_sessions_provider_status_shape
    CHECK (provider_status IS NULL OR provider_status ~ '^[a-z][a-z-]{1,31}$'),
  CONSTRAINT call_sessions_call_sid_shape CHECK (twilio_call_sid IS NULL OR twilio_call_sid ~ '^CA[0-9a-f]{32}$'),
  CONSTRAINT call_sessions_dial_call_sid_shape CHECK (dial_call_sid IS NULL OR dial_call_sid ~ '^CA[0-9a-f]{32}$'),
  CONSTRAINT call_sessions_recording_sid_shape CHECK (recording_sid IS NULL OR recording_sid ~ '^RE[0-9a-f]{32}$'),
  CONSTRAINT call_sessions_recording_path_shape
    CHECK (recording_path IS NULL OR (recording_path ~ '^/[A-Za-z0-9/._-]+$' AND length(recording_path) <= 300)),
  -- Consumed once, inside its life, and a consumed session is the one that knows its Call SID.
  CONSTRAINT call_sessions_consumed_within_life CHECK (consumed_at IS NULL OR consumed_at <= expires_at),
  CONSTRAINT call_sessions_sid_iff_consumed CHECK ((consumed_at IS NULL) = (twilio_call_sid IS NULL)),
  -- Only a consumed session has a provider's status, and a finished one says when it ended.
  CONSTRAINT call_sessions_progress_needs_consumption CHECK (status = 'authorized' OR consumed_at IS NOT NULL),
  CONSTRAINT call_sessions_finished_has_end
    CHECK (status NOT IN ('completed', 'failed', 'canceled') OR ended_at IS NOT NULL),
  CONSTRAINT call_sessions_counts_nonnegative
    CHECK ((duration_seconds IS NULL OR duration_seconds >= 0)
           AND (recording_duration_seconds IS NULL OR recording_duration_seconds >= 0)
           AND (billed_price_cents IS NULL OR billed_price_cents >= 0)),
  CONSTRAINT call_sessions_updated_not_before_created CHECK (updated_at >= created_at)
);

-- The TwiML route and the sweep find a session by id or by its age, with no workspace.
CREATE INDEX call_sessions_by_id ON call_sessions (id);
CREATE INDEX call_sessions_by_firm ON call_sessions (workspace_id, firm_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- meetings — one Cal.com booking
--
-- `booking_uid` is the booking the meeting began as; `current_booking_uid` is the one
-- it is now (a Cal.com reschedule issues a new uid and names the old one). Both are
-- unique, so either finds it. `last_event_at` is the payload timestamp of the last
-- event applied: an older event is recorded in `calcom_events` and not applied.
-- ---------------------------------------------------------------------------
CREATE TABLE meetings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  booking_uid text NOT NULL,
  current_booking_uid text NOT NULL,
  firm_id uuid,
  contact_id uuid,
  opportunity_id uuid,
  state text NOT NULL,
  state_before_no_show text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  organizer_email text,
  attendee_email text,
  last_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT meetings_booking_uid_unique UNIQUE (workspace_id, booking_uid),
  CONSTRAINT meetings_current_uid_unique UNIQUE (workspace_id, current_booking_uid),
  CONSTRAINT meetings_firm_fkey FOREIGN KEY (workspace_id, firm_id) REFERENCES firms (workspace_id, id),
  CONSTRAINT meetings_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  -- DEFERRABLE INITIALLY IMMEDIATE: checked per statement like every other key, except
  -- inside a firm merge, which defers it. The merge moves contacts before
  -- opportunities, and a meeting linked to both has its firm_id rewritten by the contact
  -- key's cascade while its opportunity is still the source's; the check has to wait for
  -- the opportunities to move (`crm/merges.ts`).
  CONSTRAINT meetings_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT meetings_uid_shape
    CHECK (booking_uid ~ '^[A-Za-z0-9_-]{1,128}$' AND current_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT meetings_state_known CHECK (state IN ('booked', 'rescheduled', 'cancelled', 'held', 'no_show')),
  CONSTRAINT meetings_no_show_remembers
    CHECK ((state = 'no_show') = (state_before_no_show IS NOT NULL)
           AND (state_before_no_show IS NULL OR state_before_no_show IN ('booked', 'rescheduled', 'held'))),
  CONSTRAINT meetings_ends_after_start CHECK (ends_at >= starts_at),
  CONSTRAINT meetings_links_need_firm CHECK ((contact_id IS NULL AND opportunity_id IS NULL) OR firm_id IS NOT NULL),
  CONSTRAINT meetings_emails_shape
    CHECK ((organizer_email IS NULL OR (organizer_email = lower(organizer_email) AND organizer_email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(organizer_email) <= 320))
           AND (attendee_email IS NULL OR (attendee_email = lower(attendee_email) AND attendee_email ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND length(attendee_email) <= 320))),
  CONSTRAINT meetings_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX meetings_by_firm ON meetings (workspace_id, firm_id, starts_at DESC);

-- ---------------------------------------------------------------------------
-- calcom_events — every verified Cal.com delivery
--
-- `event_id` is the sha256 of the verified raw body, so an exact redelivery is the
-- same row and applies once. No payload is stored: the meeting row holds what the
-- CRM needs, and the body carries the attendee's personal data.
-- ---------------------------------------------------------------------------
CREATE TABLE calcom_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  event_id text NOT NULL,
  trigger_event text NOT NULL,
  booking_uid text,
  payload_created_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  meeting_id uuid,
  CONSTRAINT calcom_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT calcom_events_once UNIQUE (workspace_id, event_id),
  CONSTRAINT calcom_events_meeting_fkey FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT calcom_events_event_id_shape CHECK (event_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT calcom_events_trigger_shape CHECK (trigger_event ~ '^[A-Z][A-Z_]{1,63}$'),
  CONSTRAINT calcom_events_booking_uid_shape CHECK (booking_uid IS NULL OR booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT calcom_events_outcome_known
    CHECK (outcome IN ('applied', 'stale', 'ignored', 'unmatched', 'malformed'))
);

-- ---------------------------------------------------------------------------
-- mail_message_duplicates — provider message ids the mail pipeline will not import
--
-- Added at the coordinator's request for the mail slice (30 September 2026). One row
-- per (mailbox, provider message id) that is either a proven duplicate of a stored
-- message (`duplicate_of_message_id` names it) or vanished at the provider before it
-- could be read. Append-only; the row goes with the message it names (ON DELETE
-- CASCADE), so the retention sweep and the deletion workflow never trip over it.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_message_duplicates (
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  duplicate_of_message_id uuid,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_duplicates_pkey PRIMARY KEY (workspace_id, mailbox_id, provider_message_id),
  CONSTRAINT mail_message_duplicates_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mail_message_duplicates_message_fkey FOREIGN KEY (workspace_id, duplicate_of_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_message_duplicates_provider_id_shape CHECK (provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT mail_message_duplicates_reason_known CHECK (reason IN ('proven_duplicate', 'vanished'))
);

-- ---------------------------------------------------------------------------
-- (e) workspace_settings — the three new keys
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled',
                           'calling_provider', 'calendar_integration', 'telephony_budget'));

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed then.
-- The two history tables are append-only; `stage_rules` is a vocabulary the runtime
-- reads and never writes.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_stage_pins TO app_runtime, migration;
GRANT SELECT, INSERT ON opportunity_values TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON opportunity_values FROM app_runtime, migration;
GRANT SELECT ON stage_rules TO app_runtime, migration;
GRANT SELECT, INSERT ON opportunity_stage_evidence TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON opportunity_stage_evidence FROM app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON stage_review_items TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_sessions TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON meetings TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON calcom_events TO app_runtime, migration;
GRANT SELECT, INSERT ON mail_message_duplicates TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON mail_message_duplicates FROM app_runtime, migration;
