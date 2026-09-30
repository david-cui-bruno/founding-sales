-- ---------------------------------------------------------------------------
-- 0026_send_path_v2.sql — the schema half of send-path v2 (slice S0, foundation)
-- changes: mail_message_effects, follow_up_permissions, hold_reason_codes, sequence_enrollments, sequence_steps, template_versions, mailboxes, crm_domain_events
--
-- David, 30 September 2026, the send-path v2 plan: a direct send is an update to the
-- conversation rather than a takeover; "existing enrollments keep their original steps,
-- template versions, and cadence ... explicitly migrating an enrollment must preserve
-- completed steps and the agreed follow-up scope"; a prospecting e-mail may not leave
-- through a conversation mailbox. Three other slices build the behaviour; this file is
-- every schema piece they share, with one owner, and nothing that changes what is sent.
--
-- ## What each table in `-- changes:` gets, and why it is named
--
--   (a) `mail_message_effects` — the kind CHECK admits `direct_send_conversation`, a
--       constraint swap under the same name. `direct_send_manual` stays admitted: the
--       rows that carry it are history and stay readable.
--   (b) `follow_up_permissions` — `consumed_reason`, nullable, and two CHECKs: the
--       reason is one of two words, and a reason is present exactly when `consumed_at`
--       is. `ADD COLUMN` (no default) still changes every row's text, so the table is
--       named.
--   (c) `hold_reason_codes` — one new code, `cold_outreach_mailbox_required`.
--   (d) `sequence_enrollments` — `migrated_from_enrollment_id`, the lineage of an
--       explicit migration (supersede): the new row names the one it replaced. The end
--       reason `migration_superseded` is already admitted (0025 re-added it); this file
--       does not touch that CHECK.
--   (e) `sequence_steps` and `template_versions` — immutability triggers (below).
--   (f) `mailboxes` — the kind CHECKs admit `cold_outreach`. A label only: nothing in
--       this feature sends through such a mailbox, and no row is converted.
--   (g) `crm_domain_events` — `owed_enrollment_ids`, the durable marker of a scoped
--       terminal stop (below).
--
-- There is no UPDATE and no DELETE of any existing row in this file. Every new CHECK is
-- satisfied by construction on existing rows (the new columns are NULL on all of them;
-- every stored mailbox is `personal`; no stored effect kind is removed), so each is
-- written VALID, as 0025's were.
--
-- ## (e) Why the immutability triggers come back
--
-- 0019 (i) dropped `template_versions_approved_immutable` and
-- `sequence_steps_only_on_a_draft` for "edit in place" (wave 2, S3): an approved
-- template and a published version's steps were edited where they stood, and the
-- outbound fence — which stores the rendered bytes before dispatch — was argued to be
-- what freezes a send. The GPT-6 plan review of send-path v2 (30 September 2026) found
-- that argument does not reach the guarantee David has now stated: the fence freezes the
-- bytes of *one* send, but a live enrollment's *next* step reads whatever the edited
-- step and the edited template say, so an enrollment agreed under one sequence could run
-- another's delays and another's text (`definitions.ts` `saveSteps`, `templates.ts`
-- `updateTemplateVersion`). Slice S2 replaces edit-in-place with "an edit creates a new
-- version"; these triggers are the database half of that rule, so a code path that
-- forgets it fails loudly instead of rewriting an agreement.
--
--   * `sequence_steps_published_immutable` refuses INSERT, UPDATE and DELETE of a step
--     whose version has left `draft` (published or retired — a retired version's steps
--     are still what its live enrollments read, and 0012's version trigger already
--     makes the retired version row itself immutable). An UPDATE is also refused when
--     it would move a step *into* such a version, and an INSERT because a step added
--     to a published version changes what a live enrollment runs next (coordinator's
--     decision, 30 September 2026). This is 0012's `sequence_steps_only_on_a_draft`
--     rule, under a new name.
--   * `template_versions_approved_immutable` refuses an UPDATE of an approved row that
--     changes anything other than the three metadata columns that legitimately move:
--     `name` (a label, not sent), `retired_at` (retiring an approved version is how it
--     stops being offered), and `updated_at`. It compares the whole row minus those
--     three, so a column a later migration adds is frozen by default rather than
--     forgotten. An **unapproved** row may change in every way, which is what lets the
--     approval transition itself (`approved_at`/`approved_by_user_id` from NULL to a
--     value, together with the bytes approved) through. Un-approving an approved row is
--     a change to the approval columns and is refused: a new version is the way.
--
-- ## (g) Scoped terminal stops: the durable marker
--
-- P0-2 of the plan review: `consumeTerminalStops` stopped every enrollment live **at
-- drain time** at the firm (manual mode) or the opportunity (close), so an enrollment
-- created after the event — S3 enrolls an agreed sequence right after logging an
-- interested call, in the same command — was killed by a stop that was never about it.
-- The fix is to record, on the event row itself, the enrollments it owes a stop to **at
-- emission**, and have the drain stop only those. No timestamp cut-off: `now()` is the
-- transaction's start, so an enrollment created later in the same transaction carries
-- the same instant as the event and no comparison can tell them apart.
--
-- `emitCrmDomainEvent` fills the column for the two terminal-stop kinds, in the INSERT
-- that writes the event (a sub-select over `sequence_enrollments`), under the exclusive
-- send gate `enrollContact` also takes first — so the set holds every enrollment
-- committed before the emission and none created after it (decision document 6a, point
-- 5). Every other kind leaves it NULL, and a CHECK says so. The rows written before this file are NULL, and
-- the drain reads NULL the way it always did — the firm or opportunity's live
-- enrollments at drain time — because a stop that was owed must not be dropped
-- because it predates the marker. An array rather than a side table: the set is
-- written once, with the event, and never updated (UPDATE is revoked on the table);
-- a side table would be a second write that could be forgotten. There is no foreign key
-- per element, and none is needed: the drain stops only live ids it finds.
--
-- ## Locks
--
-- `ALTER TABLE ... ADD COLUMN` without a default, `ADD CONSTRAINT ... CHECK/FOREIGN KEY`
-- and `CREATE TRIGGER` each take a lock on their table that is held until the file
-- commits. The release stops both services first (`deploy.sh release --schema-change`),
-- so nothing is waiting on them, and every table here is small.
--
-- Read-only, before the release; all must be 0:
--
--   SELECT count(*) FROM follow_up_permissions WHERE consumed_at IS NOT NULL;  -- the pairing CHECK
--   SELECT count(*) FROM mailboxes WHERE kind NOT IN ('personal', 'cold_outreach');
--   SELECT count(*) FROM mail_message_effects WHERE effect_kind NOT IN
--     ('hold_opened', 'opportunity_manual', 'route_invalidated', 'handle_suppressed',
--      'firm_suppressed', 'reply_lane_entry', 'direct_send_manual',
--      'direct_send_conversation', 'no_effect');
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (a) A direct send recorded as an update to the conversation
-- ---------------------------------------------------------------------------
ALTER TABLE mail_message_effects DROP CONSTRAINT IF EXISTS mail_message_effects_kind_known;
ALTER TABLE mail_message_effects
  ADD CONSTRAINT mail_message_effects_kind_known
    CHECK (effect_kind IN ('hold_opened', 'opportunity_manual', 'route_invalidated',
                           'handle_suppressed', 'firm_suppressed', 'reply_lane_entry',
                           'direct_send_manual', 'direct_send_conversation', 'no_effect'));

-- ---------------------------------------------------------------------------
-- (b) Why a permission was spent
-- ---------------------------------------------------------------------------
-- `sent`: the dispatch claim spent it (`consumeFollowUpPermission`). `fulfilled_by_direct_send`:
-- the salesperson sent the promised e-mail by hand, so the automated one must not follow.
ALTER TABLE follow_up_permissions
  ADD COLUMN consumed_reason text;

ALTER TABLE follow_up_permissions
  ADD CONSTRAINT follow_up_permissions_consumed_reason_known
    CHECK (consumed_reason IS NULL OR consumed_reason IN ('sent', 'fulfilled_by_direct_send'));

ALTER TABLE follow_up_permissions
  ADD CONSTRAINT follow_up_permissions_consumed_reason_iff_consumed
    CHECK ((consumed_reason IS NULL) = (consumed_at IS NULL));

COMMENT ON COLUMN follow_up_permissions.consumed_reason IS
  'Why consumed_at is set: sent (the dispatch claim) or fulfilled_by_direct_send (the salesperson sent it by hand). Present exactly when consumed_at is.';

-- ---------------------------------------------------------------------------
-- (c) The refusal an operator reads when a prospecting e-mail meets the wrong mailbox
-- ---------------------------------------------------------------------------
-- The description promises nothing about what clears it: a mailbox label never
-- authorises the Gmail dispatch path, and the step stays held until a cold-outreach
-- transport dispatches it. DO NOTHING on conflict, so a row somebody already put there
-- is left exactly as it is.
INSERT INTO hold_reason_codes (code, description, recoverable) VALUES
  ('cold_outreach_mailbox_required',
   'A prospecting e-mail may not leave through a conversation (Gmail) mailbox; held until a cold-outreach transport dispatches it.',
   true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- (d) The lineage of an explicit enrollment migration
-- ---------------------------------------------------------------------------
-- The new enrollment names the one it superseded; the old one ends
-- `migration_superseded`, which `sequence_enrollments_end_reason_known` admits since
-- 0025 (verified, not re-declared: `test/db/sendPathV2.test.ts` inserts an enrollment
-- ended with it at schema 26).
ALTER TABLE sequence_enrollments
  ADD COLUMN migrated_from_enrollment_id uuid;

ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_migrated_from_fkey
    FOREIGN KEY (workspace_id, migrated_from_enrollment_id)
    REFERENCES sequence_enrollments (workspace_id, id);

COMMENT ON COLUMN sequence_enrollments.migrated_from_enrollment_id IS
  'The enrollment this one superseded by an explicit migration (send-path v2). NULL for every enrollment created any other way.';

-- ---------------------------------------------------------------------------
-- (e) The steps of a published version, and an approved template's bytes, do not move
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_sequence_step_not_published() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  old_state text;
  new_state text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v.state INTO old_state
      FROM sequence_versions v
     WHERE v.workspace_id = OLD.workspace_id AND v.id = OLD.sequence_version_id;
    IF old_state IS NOT NULL AND old_state <> 'draft' THEN
      RAISE EXCEPTION 'the steps of a published sequence version are immutable; edit a new draft version'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  -- INSERT, or an UPDATE that moves the step: the version it lands in. No parent at all
  -- is the foreign key's refusal to make, by name, a moment later.
  IF TG_OP = 'INSERT'
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.sequence_version_id IS DISTINCT FROM OLD.sequence_version_id THEN
    SELECT v.state INTO new_state
      FROM sequence_versions v
     WHERE v.workspace_id = NEW.workspace_id AND v.id = NEW.sequence_version_id;
    IF new_state IS NOT NULL AND new_state <> 'draft' THEN
      RAISE EXCEPTION 'the steps of a published sequence version are immutable; edit a new draft version'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sequence_steps_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON sequence_steps
  FOR EACH ROW EXECUTE FUNCTION assert_sequence_step_not_published();

CREATE FUNCTION assert_approved_template_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['name', 'retired_at', 'updated_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['name', 'retired_at', 'updated_at']) THEN
    RAISE EXCEPTION 'an approved template version is immutable; create a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER template_versions_approved_immutable
  BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION assert_approved_template_immutable();

-- ---------------------------------------------------------------------------
-- (f) A cold-outreach mailbox is a kind a row may carry
-- ---------------------------------------------------------------------------
-- `shared` stays in the vocabulary CHECK (reserved, 12.1) and stays refused by the
-- second one; `cold_outreach` is admitted by both. Two swaps under the same names.
ALTER TABLE mailboxes DROP CONSTRAINT IF EXISTS mailboxes_kind_known;
ALTER TABLE mailboxes
  ADD CONSTRAINT mailboxes_kind_known CHECK (kind IN ('personal', 'shared', 'cold_outreach'));

ALTER TABLE mailboxes DROP CONSTRAINT IF EXISTS mailboxes_shared_kind_disabled;
ALTER TABLE mailboxes
  ADD CONSTRAINT mailboxes_shared_kind_disabled CHECK (kind IN ('personal', 'cold_outreach'));

-- ---------------------------------------------------------------------------
-- (g) The enrollments a terminal-stop event owes, recorded when it is emitted
-- ---------------------------------------------------------------------------
ALTER TABLE crm_domain_events
  ADD COLUMN owed_enrollment_ids uuid[];

ALTER TABLE crm_domain_events
  ADD CONSTRAINT crm_domain_events_owed_only_on_stops
    CHECK (owed_enrollment_ids IS NULL
           OR event_kind IN ('opportunity.terminal_stop', 'opportunity.manual_mode'));

COMMENT ON COLUMN crm_domain_events.owed_enrollment_ids IS
  'For opportunity.terminal_stop and opportunity.manual_mode: the enrollments live at emission that this event stops (send-path v2). NULL on every other kind and on every event written before migration 0026, which the drain reads as the old firm- or opportunity-wide stop.';
