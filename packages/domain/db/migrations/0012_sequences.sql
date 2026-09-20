-- ---------------------------------------------------------------------------
-- 0012 — sequences, templates, enrollments, step executions, LinkedIn
--
-- Specification revision 3, section 11 in full, 4.3 (holds shift schedules by the
-- union of their intervals), 8.2 (lane 3 is due sequence work), 12.5 and Appendix B
-- (the fence this lane hands an email step to), Appendix A rows "Enroll", "Complete
-- manual or LinkedIn step", "LinkedIn undo", "Migrate enrollments" and "Stage
-- change", Appendix C `step-execution:{id}`, Appendix D, and Appendix G scenarios
-- 9, 18, 26, 28, 31, 32 and 33.
--
-- What this migration is *not*: it does not create `template_versions`. Migration
-- 0009 created it, minimally and deliberately one pull request early, so that this
-- lane extends a table rather than racing the mail lane to invent one. Section
-- 11.1's reserved extension points are added here as nullable columns and the
-- approved-version immutability trigger is replaced so that it covers them too.
--
-- Nothing here is seeded. A workspace with no holiday calendar has none, and
-- `EMPTY_HOLIDAY_CALENDAR` in `packages/domain/src/rules/businessDays.ts` is what a
-- reader gets; a seeded calendar would be this repository asserting which days
-- Callie does not work.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- template_versions — extended, never recreated (specification 11.1)
--
-- "Schema extension points reserve `personalization_strategy`, generator/prompt
-- version, evidence IDs, generated block, and content hash. AI-generated
-- personalization is not a version-one dependency and cannot be enabled until a
-- separate evaluation and approval design passes."
--
-- So the vocabulary is reserved by the CHECK that names both strategies, and
-- `generated` is disabled by the CHECK beside it — the same pair migration 0009
-- used for the shared mailbox kind. A later release drops one line rather than
-- inventing the word again, and until then no row can carry a generated block
-- because no row can carry the strategy that would explain one.
-- ---------------------------------------------------------------------------
ALTER TABLE template_versions
  ADD COLUMN personalization_strategy text,
  ADD COLUMN generator_version text,
  ADD COLUMN prompt_version text,
  ADD COLUMN evidence_item_ids uuid[],
  ADD COLUMN generated_block text;

ALTER TABLE template_versions
  ADD CONSTRAINT template_versions_personalization_known
    CHECK (personalization_strategy IS NULL
           OR personalization_strategy IN ('deterministic', 'generated')),
  -- 11.1, and section 17's deferral list. Reserved, and refused.
  ADD CONSTRAINT template_versions_generated_personalization_disabled
    CHECK (personalization_strategy IS DISTINCT FROM 'generated'),
  -- A generated block without the strategy that produced it is provenance for
  -- nothing, and the strategy that would explain one is refused by the constraint
  -- above — so this column is reserved and unreachable until that line is dropped.
  -- The length bound lives here rather than in a constraint of its own, because a
  -- bound on a column no row can carry is a constraint no test can reach.
  ADD CONSTRAINT template_versions_generated_block_reserved
    CHECK (generated_block IS NULL
           OR (personalization_strategy = 'generated' AND length(generated_block) <= 2000)),
  ADD CONSTRAINT template_versions_generator_version_bounded
    CHECK (generator_version IS NULL
           OR (btrim(generator_version) <> '' AND length(generator_version) <= 100)),
  ADD CONSTRAINT template_versions_prompt_version_bounded
    CHECK (prompt_version IS NULL
           OR (btrim(prompt_version) <> '' AND length(prompt_version) <= 100)),
  ADD CONSTRAINT template_versions_evidence_bounded
    CHECK (evidence_item_ids IS NULL OR cardinality(evidence_item_ids) <= 20);

-- The approval is an approval of bytes. Migration 0009 froze the bytes it knew
-- about; these five columns would otherwise be editable after approval, and the
-- evidence a generated block was built from is part of what an approver approved.
CREATE OR REPLACE FUNCTION assert_approved_template_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.footer_sign_off IS DISTINCT FROM OLD.footer_sign_off
     OR NEW.footer_postal_address IS DISTINCT FROM OLD.footer_postal_address
     OR NEW.required_variables IS DISTINCT FROM OLD.required_variables
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
     OR NEW.personalization_strategy IS DISTINCT FROM OLD.personalization_strategy
     OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.evidence_item_ids IS DISTINCT FROM OLD.evidence_item_ids
     OR NEW.generated_block IS DISTINCT FROM OLD.generated_block THEN
    RAISE EXCEPTION 'an approved template version is immutable; publish a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- workspace_holiday_calendars (specification 11.2, Appendix D)
--
-- "A business-day delay skips weekends and configured workspace holidays, then
-- resolves in the firm's actual zone. Due instants are stored in UTC together with
-- the source zone and rule version."
--
-- The calendar is versioned rather than edited because the rule version stored on
-- every due instant names it: `business-day.1+<calendar version>`. Editing the
-- current row in place would make a stored instant claim a calendar it was not
-- computed from, and the whole reason the rule version is stored is to tell a
-- calendar change apart from a bug.
--
-- One current row per workspace, by partial unique index. Superseding is a new row
-- plus a `superseded_at` on the old one, in the same transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_holiday_calendars (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  version text NOT NULL,
  -- Local calendar dates in the firm's zone; a holiday is a date, never an instant.
  dates date[] NOT NULL DEFAULT '{}',
  effective_from timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_holiday_calendars_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_holiday_calendars_author_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_holiday_calendars_one_per_version UNIQUE (workspace_id, version),
  -- The version travels into a stored `rule_version` string, so it may not contain a
  -- separator that string uses.
  CONSTRAINT workspace_holiday_calendars_version_shape CHECK (version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  CONSTRAINT workspace_holiday_calendars_dates_bounded CHECK (cardinality(dates) <= 400),
  CONSTRAINT workspace_holiday_calendars_superseded_not_before_effective
    CHECK (superseded_at IS NULL OR superseded_at >= effective_from)
);

CREATE UNIQUE INDEX workspace_holiday_calendars_one_current
  ON workspace_holiday_calendars (workspace_id)
  WHERE superseded_at IS NULL;

-- ---------------------------------------------------------------------------
-- sequences (specification 11.1)
--
-- The named plan. Everything that can change is on the version, not here, so a
-- sequence row is a stable identity a report can group five years of enrollments by.
-- ---------------------------------------------------------------------------
CREATE TABLE sequences (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name text NOT NULL,
  description text,
  created_by_user_id uuid NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequences_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT sequences_author_fkey FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sequences_one_per_name UNIQUE (workspace_id, name),
  CONSTRAINT sequences_name_present CHECK (btrim(name) <> '' AND length(name) <= 200),
  CONSTRAINT sequences_description_bounded
    CHECK (description IS NULL OR (btrim(description) <> '' AND length(description) <= 1000)),
  CONSTRAINT sequences_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- sequence_versions (specification 11.1, 11.2)
--
-- "Draft versions may change; published versions and steps are immutable by
-- trigger. Editing a published sequence creates a new draft."
--
-- `stop_conditions` is the surprising column. Section 11.2 lists five terminal
-- conditions, and none of them is optional — a version that could opt out of
-- "confirmed human email reply" would be a sequence that keeps emailing somebody
-- who answered. So the column records the set, and the CHECK refuses a row that
-- does not contain every mandatory member. It is a closed set the database enforces
-- rather than a configuration a later screen could weaken, and it exists at all so
-- that a future optional condition has somewhere to live.
-- ---------------------------------------------------------------------------
CREATE TABLE sequence_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  sequence_id uuid NOT NULL,
  version integer NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  stop_conditions text[] NOT NULL DEFAULT ARRAY[
    'human_reply', 'linkedin_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'
  ],
  published_at timestamptz,
  published_by_user_id uuid,
  retired_at timestamptz,
  retired_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The semantic key steps and enrollments reference, so neither can name a version
  -- belonging to another sequence.
  CONSTRAINT sequence_versions_semantic_key UNIQUE (workspace_id, id, sequence_id),
  CONSTRAINT sequence_versions_sequence_fkey FOREIGN KEY (workspace_id, sequence_id)
    REFERENCES sequences (workspace_id, id),
  CONSTRAINT sequence_versions_publisher_fkey FOREIGN KEY (workspace_id, published_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sequence_versions_retirer_fkey FOREIGN KEY (workspace_id, retired_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sequence_versions_one_per_version UNIQUE (workspace_id, sequence_id, version),
  CONSTRAINT sequence_versions_version_positive CHECK (version >= 1),
  CONSTRAINT sequence_versions_state_known CHECK (state IN ('draft', 'published', 'retired')),
  CONSTRAINT sequence_versions_publication_consistent
    CHECK ((state = 'draft') = (published_at IS NULL)
           AND (published_at IS NULL) = (published_by_user_id IS NULL)),
  CONSTRAINT sequence_versions_retired_has_instant
    CHECK (state <> 'retired' OR (retired_at IS NOT NULL AND retired_by_user_id IS NOT NULL)),
  CONSTRAINT sequence_versions_unretired_has_no_instant
    CHECK (state = 'retired' OR (retired_at IS NULL AND retired_by_user_id IS NULL)),
  CONSTRAINT sequence_versions_retired_not_before_published
    CHECK (retired_at IS NULL OR published_at IS NULL OR retired_at >= published_at),
  -- 11.2's five terminal conditions. Every one of them is mandatory.
  CONSTRAINT sequence_versions_stop_conditions_known
    CHECK (stop_conditions <@ ARRAY[
      'human_reply', 'linkedin_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'
    ]::text[]),
  CONSTRAINT sequence_versions_stop_conditions_complete
    CHECK (ARRAY[
      'human_reply', 'linkedin_reply', 'engaged_call', 'opt_out_or_suppression', 'stage_closed'
    ]::text[] <@ stop_conditions),
  CONSTRAINT sequence_versions_updated_not_before_created CHECK (updated_at >= created_at)
);

ALTER TABLE sequence_versions ADD CONSTRAINT sequence_versions_pkey PRIMARY KEY (workspace_id, id);

-- "Editing a published sequence creates a new draft" — so there is at most one draft
-- to edit, and a second concurrent editor is refused by the database rather than by
-- a screen.
CREATE UNIQUE INDEX sequence_versions_one_draft
  ON sequence_versions (workspace_id, sequence_id)
  WHERE state = 'draft';

CREATE INDEX sequence_versions_published
  ON sequence_versions (workspace_id, sequence_id)
  WHERE state = 'published';

-- ---------------------------------------------------------------------------
-- sequence_steps (specification 11.1, 11.3, 9.1)
--
-- Three channels. An email step names an immutable approved template version; a
-- LinkedIn step carries its own rendered text, because 11.1 asks only email steps to
-- reference templates and a LinkedIn message has no subject, no postal footer and no
-- reply-to-stop line — three things `template_versions` requires of an approved row.
-- The LinkedIn text is immutable for the same reason the rest of the step is: it is
-- frozen with the published version.
--
-- `on_no_answer` is 9.1's last-but-one row, "Record the attempt and follow the step's
-- configured `advance | retry_call` behavior", and it exists only on a call step.
-- ---------------------------------------------------------------------------
CREATE TABLE sequence_steps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  sequence_version_id uuid NOT NULL,
  ordinal integer NOT NULL,
  channel text NOT NULL,
  delay_unit text NOT NULL,
  -- Hours for `elapsed`, whole days for `business_days`. One column, because the
  -- unit is beside it and two nullable columns would allow a row with neither.
  delay_amount integer NOT NULL,
  on_no_answer text,
  template_version_id uuid,
  linkedin_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_steps_semantic_key UNIQUE (workspace_id, id, sequence_version_id),
  CONSTRAINT sequence_steps_version_fkey FOREIGN KEY (workspace_id, sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id),
  CONSTRAINT sequence_steps_template_fkey FOREIGN KEY (workspace_id, template_version_id)
    REFERENCES template_versions (workspace_id, id),
  CONSTRAINT sequence_steps_one_per_ordinal UNIQUE (workspace_id, sequence_version_id, ordinal),
  CONSTRAINT sequence_steps_ordinal_positive CHECK (ordinal >= 1),
  CONSTRAINT sequence_steps_channel_known CHECK (channel IN ('email', 'call_task', 'linkedin_task')),
  CONSTRAINT sequence_steps_delay_unit_known CHECK (delay_unit IN ('elapsed', 'business_days')),
  -- A year of hours, or a year of business days. Beyond that is a typing mistake
  -- nobody meant, and a due instant nobody will be here for.
  --
  -- Two constraints rather than one that mentions the unit: a row with an unknown
  -- unit would otherwise break both this and `delay_unit_known`, and a constraint
  -- that cannot be broken on its own is a constraint no failing insert can test.
  CONSTRAINT sequence_steps_delay_bounded CHECK (delay_amount >= 0 AND delay_amount <= 8760),
  CONSTRAINT sequence_steps_business_days_bounded
    CHECK (delay_unit <> 'business_days' OR delay_amount <= 365),
  CONSTRAINT sequence_steps_no_answer_is_a_call_step
    CHECK ((channel = 'call_task') = (on_no_answer IS NOT NULL)),
  CONSTRAINT sequence_steps_no_answer_known
    CHECK (on_no_answer IS NULL OR on_no_answer IN ('advance', 'retry_call')),
  CONSTRAINT sequence_steps_email_has_template
    CHECK ((channel = 'email') = (template_version_id IS NOT NULL)),
  CONSTRAINT sequence_steps_linkedin_has_message
    CHECK ((channel = 'linkedin_task') = (linkedin_message IS NOT NULL)),
  CONSTRAINT sequence_steps_linkedin_message_bounded
    CHECK (linkedin_message IS NULL
           OR (btrim(linkedin_message) <> '' AND length(linkedin_message) <= 1200)),
  -- 12.6 and David's decision: no web unsubscribe link anywhere, including here.
  CONSTRAINT sequence_steps_no_unsubscribe_link
    CHECK (linkedin_message IS NULL OR linkedin_message !~* 'unsubscribe')
);

ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_pkey PRIMARY KEY (workspace_id, id);

CREATE INDEX sequence_steps_by_version ON sequence_steps (workspace_id, sequence_version_id, ordinal);

-- ---------------------------------------------------------------------------
-- Immutability by trigger (specification 11.1)
--
-- A draft may change in every way. A published version may only be retired, and a
-- retired one may not change at all. Steps follow their version: no insert, no
-- update and no delete once the version they belong to has left `draft`.
--
-- Two triggers rather than one because they guard different tables, and the step
-- guard has to read the parent — which is why it locks nothing: `FOR EACH ROW
-- BEFORE` on the child while the parent's own trigger refuses the publish-time
-- change means the only interleaving that matters, "publish and add a step at the
-- same instant", is serialized by the row lock the publisher already holds on the
-- version.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_sequence_version_mutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'published'
     AND NEW.state = 'retired'
     AND NEW.sequence_id IS NOT DISTINCT FROM OLD.sequence_id
     AND NEW.version IS NOT DISTINCT FROM OLD.version
     AND NEW.stop_conditions IS NOT DISTINCT FROM OLD.stop_conditions
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
     AND NEW.published_by_user_id IS NOT DISTINCT FROM OLD.published_by_user_id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a published sequence version is immutable; create a new draft'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER sequence_versions_immutable_once_published
  BEFORE UPDATE ON sequence_versions
  FOR EACH ROW EXECUTE FUNCTION assert_sequence_version_mutable();

CREATE FUNCTION assert_sequence_version_not_deleted() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'a published sequence version is never deleted; retire it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER sequence_versions_published_not_deleted
  BEFORE DELETE ON sequence_versions
  FOR EACH ROW EXECUTE FUNCTION assert_sequence_version_not_deleted();

CREATE FUNCTION assert_sequence_step_version_is_draft() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_state text;
  parent_workspace uuid;
  parent_version uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_workspace := OLD.workspace_id;
    parent_version := OLD.sequence_version_id;
  ELSE
    parent_workspace := NEW.workspace_id;
    parent_version := NEW.sequence_version_id;
  END IF;

  SELECT v.state INTO parent_state
    FROM sequence_versions v
   WHERE v.workspace_id = parent_workspace AND v.id = parent_version;

  -- No parent at all is not this trigger's refusal to make: the foreign key says so
  -- a moment later, by name, and a trigger that spoke first would hide it.
  IF parent_state IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF parent_state <> 'draft' THEN
    RAISE EXCEPTION 'the steps of a published sequence version are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sequence_steps_only_on_a_draft
  BEFORE INSERT OR UPDATE OR DELETE ON sequence_steps
  FOR EACH ROW EXECUTE FUNCTION assert_sequence_step_version_is_draft();

-- ---------------------------------------------------------------------------
-- sequence_enrollments (specification 11.2, 7.2, Appendix A "Enroll")
--
-- "An enrollment binds an immutable sequence version to `(workspace, opportunity,
-- firm, contact)` and assigned salesperson. One partial unique constraint permits
-- only one active enrollment per contact, regardless of sequence."
--
-- Both composite foreign keys are onto G3a's semantic keys, so an enrollment cannot
-- mix a contact at one firm with an opportunity at another. That is section 7.2's
-- last paragraph, enforced rather than documented.
--
-- The firm's zone and the holiday calendar version are copied on to the enrollment
-- at the moment it starts. A firm that later moves does not silently re-time an
-- enrollment that is halfway through, and the card can say which calendar produced
-- the instants it is showing.
--
-- `ended_at IS NULL` is the live predicate, and it covers `review_required` as well
-- as `active`: an enrollment waiting for the salesperson to look at a long hold is
-- still that contact's one enrollment, and a second one started beside it would be
-- two sequences to the same person.
-- ---------------------------------------------------------------------------
CREATE TABLE sequence_enrollments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  sequence_version_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  assigned_user_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  -- Frozen at enrollment (Appendix D).
  firm_time_zone text NOT NULL,
  holiday_calendar_version text NOT NULL,
  -- 11.1's audited migration pauses an enrollment before it remaps anything.
  migration_paused_at timestamptz,
  -- 4.3: the union that sent this enrollment to review, for the screen that shows it.
  review_union_milliseconds bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_enrollments_semantic_key UNIQUE (workspace_id, id, firm_id),
  CONSTRAINT sequence_enrollments_version_fkey FOREIGN KEY (workspace_id, sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id),
  CONSTRAINT sequence_enrollments_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id),
  CONSTRAINT sequence_enrollments_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT sequence_enrollments_assignee_fkey FOREIGN KEY (workspace_id, assigned_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sequence_enrollments_state_known
    CHECK (state IN ('active', 'review_required', 'completed', 'stopped')),
  CONSTRAINT sequence_enrollments_live_has_no_end
    CHECK ((state IN ('active', 'review_required')) = (ended_at IS NULL)),
  CONSTRAINT sequence_enrollments_end_has_reason CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  -- 11.2's terminal conditions, plus the three ends that are not a prospect signal:
  -- the plan ran out, an admin stopped it, and a migration replaced it.
  CONSTRAINT sequence_enrollments_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN (
      'human_reply', 'linkedin_reply', 'engaged_call', 'opt_out', 'firm_suppressed',
      'stage_won', 'stage_lost', 'direct_send', 'send_skipped', 'reassignment',
      'sequence_complete', 'admin_stop', 'migration_superseded'
    )),
  CONSTRAINT sequence_enrollments_end_not_before_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT sequence_enrollments_zone_shape
    CHECK (firm_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  CONSTRAINT sequence_enrollments_calendar_version_shape
    CHECK (holiday_calendar_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  CONSTRAINT sequence_enrollments_review_union_present
    CHECK ((state = 'review_required') = (review_union_milliseconds IS NOT NULL)),
  CONSTRAINT sequence_enrollments_review_union_positive
    CHECK (review_union_milliseconds IS NULL OR review_union_milliseconds >= 0),
  CONSTRAINT sequence_enrollments_updated_not_before_created CHECK (updated_at >= created_at)
);

ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_pkey PRIMARY KEY (workspace_id, id);

-- 11.2: "One partial unique constraint permits only one active enrollment per
-- contact, regardless of sequence." Unlimited contacts at one firm may be enrolled;
-- there is deliberately no index on (workspace_id, firm_id).
CREATE UNIQUE INDEX sequence_enrollments_one_active_per_contact
  ON sequence_enrollments (workspace_id, contact_id)
  WHERE ended_at IS NULL;

CREATE INDEX sequence_enrollments_live_by_firm
  ON sequence_enrollments (workspace_id, firm_id)
  WHERE ended_at IS NULL;

CREATE INDEX sequence_enrollments_live_by_opportunity
  ON sequence_enrollments (workspace_id, opportunity_id)
  WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------------
-- step_executions (specification 11.2, 11.3, Appendix B, Appendix C)
--
-- "`step_executions` are unique by enrollment and step, with state, due instant,
-- `not_before`, completion source, result, and original/shifted timing history."
--
-- Unique by enrollment and step is also what makes 9.1's `retry_call` a re-armed
-- row rather than a second one: a retry moves `due_at` forward and increments
-- `attempt_count`, and the uniqueness that Appendix C's `step-execution:{id}` key
-- rests on is never weakened to let a retry through.
--
-- `not_before` is separate from `due_at` because 11.3's LinkedIn successor is due
-- when its delay says and may not run for ten minutes regardless — the undo window.
-- A claim requires both, and `jobs` applies the same pair for the same reason.
--
-- `firm_id` is here for the composite foreign key onto the enrollment's semantic
-- key, which is what stops an execution naming an enrollment at another firm.
-- ---------------------------------------------------------------------------
CREATE TABLE step_executions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  step_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  channel text NOT NULL,
  ordinal integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  due_at timestamptz NOT NULL,
  not_before timestamptz NOT NULL,
  -- The instant the cadence first produced, kept for the whole life of the row.
  original_due_at timestamptz NOT NULL,
  source_zone text NOT NULL,
  rule_version text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  hold_reason_code text REFERENCES hold_reason_codes (code),
  completion_source text,
  result text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT step_executions_semantic_key UNIQUE (workspace_id, id, enrollment_id),
  CONSTRAINT step_executions_enrollment_fkey FOREIGN KEY (workspace_id, enrollment_id, firm_id)
    REFERENCES sequence_enrollments (workspace_id, id, firm_id),
  CONSTRAINT step_executions_step_fkey FOREIGN KEY (workspace_id, step_id)
    REFERENCES sequence_steps (workspace_id, id),
  CONSTRAINT step_executions_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id),
  CONSTRAINT step_executions_one_per_step UNIQUE (workspace_id, enrollment_id, step_id),
  CONSTRAINT step_executions_channel_known CHECK (channel IN ('email', 'call_task', 'linkedin_task')),
  CONSTRAINT step_executions_ordinal_positive CHECK (ordinal >= 1),
  CONSTRAINT step_executions_state_known
    CHECK (state IN ('pending', 'held', 'dispatched', 'completed', 'cancelled')),
  CONSTRAINT step_executions_held_has_reason CHECK ((state = 'held') = (hold_reason_code IS NOT NULL)),
  CONSTRAINT step_executions_completion_consistent
    CHECK ((state = 'completed') = (completed_at IS NOT NULL)
           AND (completed_at IS NULL) = (completion_source IS NULL)
           AND (completed_at IS NULL) = (result IS NULL)),
  CONSTRAINT step_executions_cancel_consistent
    CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)
           AND (cancelled_at IS NULL) = (cancel_reason IS NULL)),
  -- 11.3: `open_and_copy` is how a LinkedIn step completes; `send` is the outbound
  -- fence's; `call_log` is G4's; `admin` is the unknown-terminal resolution of
  -- Appendix B; `system` is the cadence completing a step nothing external did.
  CONSTRAINT step_executions_completion_source_known
    CHECK (completion_source IS NULL
           OR completion_source IN ('open_and_copy', 'call_log', 'send', 'admin', 'system')),
  CONSTRAINT step_executions_result_known
    CHECK (result IS NULL OR result IN (
      'handed_off', 'sent', 'skipped', 'no_email', 'voicemail_left', 'no_answer',
      'busy', 'connected', 'not_applicable'
    )),
  CONSTRAINT step_executions_attempts_bounded CHECK (attempt_count >= 0 AND attempt_count <= 20),
  CONSTRAINT step_executions_zone_shape
    CHECK (source_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$'),
  CONSTRAINT step_executions_rule_version_bounded
    CHECK (btrim(rule_version) <> '' AND length(rule_version) <= 80),
  CONSTRAINT step_executions_cancel_reason_bounded
    CHECK (cancel_reason IS NULL OR (btrim(cancel_reason) <> '' AND length(cancel_reason) <= 100)),
  CONSTRAINT step_executions_updated_not_before_created CHECK (updated_at >= created_at)
);

ALTER TABLE step_executions ADD CONSTRAINT step_executions_pkey PRIMARY KEY (workspace_id, id);

-- The scheduler's due-work query. Runnable means unfinished, due and past its grace.
--
-- `held` is in the predicate and `pending` is not the whole story, because four of
-- section 15's reasons clear with the clock rather than with a person — a daily cap,
-- the domain guard, a closed window, a reconciling fence — and the worker re-arms
-- those itself. `not_before` is what stops that being a spin: a step held for one of
-- them has its `not_before` pushed forward by the reason's own interval.
CREATE INDEX step_executions_runnable
  ON step_executions (workspace_id, due_at, not_before)
  WHERE state IN ('pending', 'held');

CREATE INDEX step_executions_by_enrollment ON step_executions (workspace_id, enrollment_id, ordinal);

CREATE INDEX step_executions_unfinished_by_firm
  ON step_executions (workspace_id, firm_id)
  WHERE state IN ('pending', 'held');

-- ---------------------------------------------------------------------------
-- step_execution_shifts (specification 4.3, 11.2) — append-only
--
-- "When all applicable holds clear, unexecuted work shifts by the union of blocking
-- intervals." The union is computed once and applied to every unexecuted step; this
-- table is the record of which union moved which step and by how much, so a card
-- that says "three days later than planned" can say why.
--
-- Append-only by privilege, like `audit_events` and `suppression_events`. A shift
-- that could be rewritten would make `original_due_at` the only honest column, and
-- the history 11.2 asks for would be a single number.
-- ---------------------------------------------------------------------------
CREATE TABLE step_execution_shifts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  step_execution_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  from_due_at timestamptz NOT NULL,
  to_due_at timestamptz NOT NULL,
  shift_milliseconds bigint NOT NULL,
  reason text NOT NULL,
  -- The union that produced the shift, when a hold release produced it.
  hold_union_milliseconds bigint,
  source_event_id uuid,
  shifted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT step_execution_shifts_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT step_execution_shifts_execution_fkey FOREIGN KEY (workspace_id, step_execution_id, enrollment_id)
    REFERENCES step_executions (workspace_id, id, enrollment_id),
  CONSTRAINT step_execution_shifts_reason_known
    CHECK (reason IN ('hold_union', 'send_window', 'migration', 'retry_call', 'linkedin_grace')),
  -- 4.3 and `shiftDueInstant`: a schedule shift never moves work earlier.
  CONSTRAINT step_execution_shifts_never_earlier
    CHECK (to_due_at >= from_due_at AND shift_milliseconds >= 0),
  CONSTRAINT step_execution_shifts_union_positive
    CHECK (hold_union_milliseconds IS NULL OR hold_union_milliseconds >= 0)
);

CREATE INDEX step_execution_shifts_by_execution
  ON step_execution_shifts (workspace_id, step_execution_id, shifted_at);

-- ---------------------------------------------------------------------------
-- enrollment_linkedin_results (specification 11.3, Appendix G 18)
--
-- "'They replied' remains available for the enrollment's life and terminally
-- switches the opportunity to manual. 'No engagement' records an observation but
-- does not claim delivery."
--
-- Two different things in one table because they are the same gesture from the
-- salesperson's side, and the difference between them is exactly the `result`
-- column. A `replied` is terminal, so there is at most one per enrollment; a
-- `no_engagement` is an observation and there may be several.
-- ---------------------------------------------------------------------------
CREATE TABLE enrollment_linkedin_results (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  step_execution_id uuid,
  result text NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  note text,
  CONSTRAINT enrollment_linkedin_results_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT enrollment_linkedin_results_enrollment_fkey
    FOREIGN KEY (workspace_id, enrollment_id, firm_id)
    REFERENCES sequence_enrollments (workspace_id, id, firm_id),
  CONSTRAINT enrollment_linkedin_results_execution_fkey
    FOREIGN KEY (workspace_id, step_execution_id, enrollment_id)
    REFERENCES step_executions (workspace_id, id, enrollment_id),
  CONSTRAINT enrollment_linkedin_results_author_fkey FOREIGN KEY (workspace_id, recorded_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT enrollment_linkedin_results_result_known CHECK (result IN ('replied', 'no_engagement')),
  CONSTRAINT enrollment_linkedin_results_note_bounded
    CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500))
);

CREATE UNIQUE INDEX enrollment_linkedin_results_one_reply
  ON enrollment_linkedin_results (workspace_id, enrollment_id)
  WHERE result = 'replied';

-- ---------------------------------------------------------------------------
-- enrollment_migrations and their items (specification 11.1, Appendix A)
--
-- "A published correction in use requires an audited admin migration: pause selected
-- enrollments; map only unexecuted steps; preserve executed history; recompute due
-- times; validate version agreement; and require explicit approval."
--
-- Two tables: the command and its per-enrollment result. The result is a row rather
-- than a count because "validate version agreement" means some enrollments are
-- refused, and an admin who is told "nine of twelve" without being told which three
-- has not been told anything.
-- ---------------------------------------------------------------------------
CREATE TABLE enrollment_migrations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  from_sequence_version_id uuid NOT NULL,
  to_sequence_version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'proposed',
  requested_by_user_id uuid NOT NULL,
  approved_by_user_id uuid,
  approved_at timestamptz,
  applied_at timestamptz,
  command_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_migrations_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT enrollment_migrations_from_fkey FOREIGN KEY (workspace_id, from_sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id),
  CONSTRAINT enrollment_migrations_to_fkey FOREIGN KEY (workspace_id, to_sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id),
  CONSTRAINT enrollment_migrations_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT enrollment_migrations_approver_fkey FOREIGN KEY (workspace_id, approved_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT enrollment_migrations_not_a_self_migration
    CHECK (from_sequence_version_id <> to_sequence_version_id),
  CONSTRAINT enrollment_migrations_state_known
    CHECK (state IN ('proposed', 'approved', 'applied', 'abandoned')),
  CONSTRAINT enrollment_migrations_approval_consistent
    CHECK ((approved_at IS NULL) = (approved_by_user_id IS NULL)),
  -- "require explicit approval": applied implies approved, and the database says so.
  CONSTRAINT enrollment_migrations_applied_was_approved
    CHECK (state <> 'applied' OR (approved_at IS NOT NULL AND applied_at IS NOT NULL)),
  CONSTRAINT enrollment_migrations_applied_consistent
    CHECK ((state = 'applied') = (applied_at IS NOT NULL))
);

CREATE TABLE enrollment_migration_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  migration_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'selected',
  refusal_code text,
  executions_remapped integer NOT NULL DEFAULT 0,
  executions_preserved integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_migration_items_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT enrollment_migration_items_migration_fkey FOREIGN KEY (workspace_id, migration_id)
    REFERENCES enrollment_migrations (workspace_id, id),
  CONSTRAINT enrollment_migration_items_enrollment_fkey FOREIGN KEY (workspace_id, enrollment_id, firm_id)
    REFERENCES sequence_enrollments (workspace_id, id, firm_id),
  CONSTRAINT enrollment_migration_items_one_per_enrollment
    UNIQUE (workspace_id, migration_id, enrollment_id),
  CONSTRAINT enrollment_migration_items_outcome_known
    CHECK (outcome IN ('selected', 'remapped', 'refused')),
  CONSTRAINT enrollment_migration_items_refusal_consistent
    CHECK ((outcome = 'refused') = (refusal_code IS NOT NULL)),
  CONSTRAINT enrollment_migration_items_refusal_known
    CHECK (refusal_code IS NULL OR refusal_code IN (
      'version_mismatch', 'enrollment_not_live', 'step_already_executed', 'no_matching_step'
    )),
  CONSTRAINT enrollment_migration_items_counts_positive
    CHECK (executions_remapped >= 0 AND executions_preserved >= 0)
);

-- ---------------------------------------------------------------------------
-- sequence_event_cursors (G3a's outbox, `docs/decisions/g3a-domain-event-outbox.md`)
--
-- `crm_domain_events` has no consumption column on purpose: "a subscriber's progress
-- is its own business", which is what lets this lane and the Today lane read the
-- same stream at different speeds. This is this lane's own high-water mark.
--
-- The cursor and whatever the consumption did commit together, which is what makes
-- the terminal stop exactly once without the outbox knowing anybody read it.
-- ---------------------------------------------------------------------------
CREATE TABLE sequence_event_cursors (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  subscriber text NOT NULL,
  last_event_at timestamptz,
  last_event_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequence_event_cursors_pkey PRIMARY KEY (workspace_id, subscriber),
  CONSTRAINT sequence_event_cursors_subscriber_shape CHECK (subscriber ~ '^[a-z][a-z0-9_.]{2,63}$'),
  CONSTRAINT sequence_event_cursors_progress_consistent
    CHECK ((last_event_at IS NULL) = (last_event_id IS NULL))
);

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so each table here needs its own grant.
--
-- `step_execution_shifts` is append-only for the reason in its comment. Everything
-- else keeps DELETE, because 10.3's documented deletion workflow has to be able to
-- remove a firm's history.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_holiday_calendars TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON sequences TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON sequence_versions TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON sequence_steps TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON sequence_enrollments TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON step_executions TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON enrollment_linkedin_results TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON enrollment_migrations TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON enrollment_migration_items TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON sequence_event_cursors TO app_runtime, migration;

GRANT SELECT, INSERT ON step_execution_shifts TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON step_execution_shifts FROM app_runtime, migration;

-- ---------------------------------------------------------------------------
-- The two foreign keys migration 0010 left for this one (specification 11.2, 12.5)
--
-- `0010_outbound.sql` says it beside the columns: "Exactly one origin. Neither table
-- exists yet; G8's 0012 adds the foreign keys." Both columns are nullable there, and
-- stay nullable here — a draft send has no enrollment and no step execution, and
-- 0010's own CHECK is what makes exactly one origin true.
--
-- They are two separate keys rather than one composite key through
-- `step_executions_semantic_key (workspace_id, id, enrollment_id)`, which would have
-- been the stronger statement. A composite key with a NULL component is not checked
-- at all under MATCH SIMPLE, and 0010 permits a fence with a step execution and no
-- enrollment; the composite would therefore have silently stopped enforcing the half
-- that matters most. Two keys are checked independently and both always apply.
-- ---------------------------------------------------------------------------
ALTER TABLE outbound_messages
  ADD CONSTRAINT outbound_messages_enrollment_fkey
    FOREIGN KEY (workspace_id, enrollment_id) REFERENCES sequence_enrollments (workspace_id, id),
  ADD CONSTRAINT outbound_messages_step_execution_fkey
    FOREIGN KEY (workspace_id, step_execution_id) REFERENCES step_executions (workspace_id, id);
