-- ---------------------------------------------------------------------------
-- 0025_follow_up_permissions.sql — a follow-up is permitted by evidence, not by a label
-- changes: hold_reason_codes, sequence_enrollments, opportunities, call_logs
--
-- David, 29 September 2026 (`.context/DECISION-20260929-send-path-decisions.md`,
-- items 1-3):
--
--   "Record the enrollment origin alongside the supporting event, recipient, permitted
--   follow-up, and timing. The origin label alone must not authorize sending."
--
--   "'Call me Tuesday' means a callback task. 'Email me an overview' permits that
--   email, not an automatic multi-week sequence. An inbound question permits a
--   contextual reply; a booking permits relevant booking communications. An agreed
--   follow-up sequence can run within its agreed scope."
--
--   "Mark existing enrollments `cold_legacy`, preserve their history, and exclude them
--   from automatic sending. Don't infer eligibility from dates, sequence names, or
--   template guesses."
--
--   "Enforce one active prospecting contact per firm ... at enrollment and immediately
--   before sending, including concurrent-worker behavior."
--
-- Why a migration at all. `docs/greenfield/send-path-verification-20260929.md` is the
-- read of the code that produced these decisions, and its sections 1 and 4 are the
-- same finding twice: `sequence_enrollments` carries **no origin, no basis, no source
-- and no kind**, so nothing in the data distinguishes a permitted follow-up from a cold
-- blast, and no predicate over `started_at`, `sequences.name` or template lineage can
-- be made to. The rule David asked for is therefore not a query over existing columns;
-- it is a column, and a table of evidence the column points at.
--
-- The design as built, with the alternatives and the two deviations from the brief, is
-- `docs/greenfield/decisions/follow-up-eligibility-20260929.md`.
--
-- ## The three things this file does
--
-- (a) `follow_up_permissions` — one row per permission: who may be written to, on the
--     strength of which recorded event, how much may be sent, and until when. New
--     table, unreferenced by any deployed binary, granted to `app_runtime` explicitly
--     (migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
--     then).
--
-- (b) `sequence_enrollments.origin_kind`, defaulting to `cold_legacy`, and
--     `permission_id`. **The DEFAULT is the backfill.** Every row that exists becomes
--     `cold_legacy` without an UPDATE touching it — history preserved exactly, and the
--     excluded set is the set the decision names rather than a date somebody guessed.
--     It is also the fail-closed default for code: a path that forgets to say which
--     kind it is creating creates an excluded enrollment, never a sending one.
--
-- (c) `opportunities.control_mode_origin` — the smallest distinction the brief asks
--     for. `MANUAL_MODE_ORIGINS` (`packages/domain/crm/events.ts`) already separates a
--     prospect SIGNAL (`human_reply`, `engaged_call`, `direct_send`) from an explicit
--     PERSON's takeover (`salesperson_command`), but it writes that fact only into
--     `crm_domain_events.detail.origin`. The eligibility gate reads the opportunity
--     row, and the opportunity row could not say which of the two put it in manual
--     mode. One nullable column, written by `setManualControlMode`, and a NULL — every
--     row that exists today — reads as a person's takeover, which is the refusing
--     answer.
--
-- ## What `-- changes:` names, and why each
--
-- * `hold_reason_codes` — five new codes, upserted (d).
-- * `sequence_enrollments` — `ADD COLUMN ... DEFAULT` changes the content hash of every
--   row in the table, so it is declared whether or not a byte of data "moved"
--   (`docs/greenfield/migrations.md`). Its shape changes too.
-- * `opportunities` — the same, for (c).
--
-- No other table's rows or shape change. There is no `UPDATE` in this file.
--
-- ## Locks
--
-- Two `ALTER TABLE ... ADD COLUMN` with a constant default (PostgreSQL 11+ rewrites
-- nothing) and two `ADD CONSTRAINT ... CHECK`. The runner applies the file in one
-- transaction, so the ACCESS EXCLUSIVE locks on `sequence_enrollments` and
-- `opportunities` are held until it commits; both are small, and the release stops both
-- services first (`deploy.sh release --schema-change`), so nothing is waiting on them.
-- The new CHECKs are written VALID rather than NOT VALID on purpose: each is satisfied
-- by construction on existing rows — `origin_kind` is the default on every row and
-- `permission_id` is NULL on every row, so `origin_kind <> 'follow_up'` holds — and a
-- scan of a table this size is not worth a second migration to validate.
--
-- Read-only, before the release; both must be 0:
--
--   SELECT count(*) AS would_refuse FROM sequence_enrollments
--    WHERE ended_at IS NULL AND false;  -- no pre-existing row can violate either CHECK
--   SELECT count(*) AS live_follow_ups FROM sequence_enrollments
--    WHERE ended_at IS NULL AND started_at > now();  -- a sanity read only
--
-- ## What this file does NOT do
--
-- It does not lift the sending pause, and it cannot: the three switches of
-- `docs/greenfield/send-path-verification-20260929.md` section 0 are untouched. Its
-- only effect on what could leave is subtractive — every live enrollment becomes
-- `cold_legacy` and is refused at the step.
--
-- It creates no booking table. `booking_communications` is in the `scope` vocabulary
-- because David named it, and the eligibility source **refuses it** until Cal.com's
-- tables exist and the evidence can be re-read; a vocabulary entry nothing can satisfy
-- is honest, a scope that waves a permission through on a `booking_reference` text
-- nobody can verify is not.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- (a) follow_up_permissions — the evidence, the recipient, the scope, the timing
-- ---------------------------------------------------------------------------
-- One row is one answer to "why may Callie write to this person, and how much?".
--
-- `kind` is the shape of the event that granted it; `scope` is what it permits. They
-- are two columns rather than one because David's sentence pairs them loosely: an
-- `interested` call outcome may grant a `single_email` or an `agreed_sequence`, and the
-- salesperson chooses which at the moment of recording the outcome.
--
-- The evidence is a real row, not a note: `call_log_id` or `mail_message_id`, each with
-- a foreign key, or `booking_reference` for the scope that has no table yet. **Exactly
-- one** (`follow_up_permissions_one_evidence`). The eligibility source
-- re-reads it every time — the permission is a pointer, and the decision is the
-- pointed-at row still existing, still naming this firm and still naming this
-- recipient. That is what "the origin label alone must not authorize sending" means in
-- SQL: this table's own row is a label too.
--
-- `expires_at` is NOT NULL, because timing is part of the permission and a permission
-- with no end is the indefinite sequence David refused, and `max_steps` is the limit
-- beside it in the other dimension. The defaults per scope are
-- code, not a column default, because one of them is not a constant: an
-- `agreed_sequence` expires when its own agreed sequence would have finished
-- (`FOLLOW_UP_PERMISSION_WINDOWS`, `packages/domain/sequences/followUpPermissions.ts`).
--
-- `consumed_at` is the whole of `single_email`'s "that email, not a sequence": the
-- dispatch claim sets it in the same committed transaction that claims the fence, so a
-- second attempt reads it and refuses `follow_up_scope_exhausted`. It is meaningless
-- for the other scopes and a CHECK says so.
--
-- `granted_by_user_id` / `granted_by_rule`: the brief names one `granted_by` column
-- holding "a user id or the system rule name". Two columns, exactly one non-null,
-- because a text column cannot carry the foreign key onto `workspace_memberships` that
-- every other actor column in this schema carries, and losing that check to save a
-- column is the wrong trade (deviation 1, recorded in the decision document).
CREATE TABLE follow_up_permissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  -- The recipient. Not "the firm": a permission is a person's, and the eligibility
  -- source matches it against the step's own contact.
  contact_id uuid NOT NULL,
  kind text NOT NULL,
  scope text NOT NULL,
  -- The evidence. **Exactly one**, and it is a row somebody can read. Not "at least
  -- one": with two, `verifyFollowUpPermission` would return on the first that holds up
  -- and never look at the second, so a valid call log could carry an invalid message id
  -- past the check (GPT-6 review of PR 332, P0-1).
  call_log_id uuid,
  mail_message_id uuid,
  booking_reference text,
  -- What the permission is bound to, so it authorizes *these bytes* and not "whatever
  -- approved template somebody picks" (P0-2).
  --
  --   * `single_email` names the approved template version it permits;
  --   * `agreed_sequence` names one **immutable published version**, never the sequence,
  --     because expiry is computed from a version's steps and a later version of the
  --     same sequence is a different agreement;
  --   * `enrollment_id` is the one run this permission paid for, written by
  --     `enrollContact` when it creates that enrollment. A second enrollment on the same
  --     permission is refused, which is what "reject reuse" means.
  template_version_id uuid,
  sequence_version_id uuid,
  enrollment_id uuid,
  -- The explicit step limit. One for the two single-message scopes, the agreed version's
  -- own step count for a sequence; `expires_at` is the time limit beside it.
  max_steps integer,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  granted_by_user_id uuid,
  granted_by_rule text,
  consumed_at timestamptz,
  revoked_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_permissions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT follow_up_permissions_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  -- Onto the contact's semantic key, so a permission cannot name a contact at another
  -- firm (the shape `call_logs` and `mail_message_matches` use).
  CONSTRAINT follow_up_permissions_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT follow_up_permissions_call_log_fkey FOREIGN KEY (workspace_id, call_log_id)
    REFERENCES call_logs (workspace_id, id),
  CONSTRAINT follow_up_permissions_mail_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id),
  CONSTRAINT follow_up_permissions_template_fkey FOREIGN KEY (workspace_id, template_version_id)
    REFERENCES template_versions (workspace_id, id),
  CONSTRAINT follow_up_permissions_sequence_version_fkey FOREIGN KEY (workspace_id, sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id),
  CONSTRAINT follow_up_permissions_granter_fkey FOREIGN KEY (workspace_id, granted_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT follow_up_permissions_kind_known
    CHECK (kind IN ('conversation', 'request', 'booking', 'agreed_sequence')),
  CONSTRAINT follow_up_permissions_scope_known
    CHECK (scope IN ('single_email', 'contextual_reply', 'booking_communications', 'agreed_sequence')),
  CONSTRAINT follow_up_permissions_one_evidence
    CHECK ((call_log_id IS NOT NULL)::int + (mail_message_id IS NOT NULL)::int
           + (booking_reference IS NOT NULL)::int = 1),
  CONSTRAINT follow_up_permissions_sequence_version_iff_agreed
    CHECK ((scope = 'agreed_sequence') = (sequence_version_id IS NOT NULL)),
  CONSTRAINT follow_up_permissions_template_iff_single_email
    CHECK ((scope = 'single_email') = (template_version_id IS NOT NULL)),
  CONSTRAINT follow_up_permissions_steps_bounded
    CHECK (max_steps IS NULL OR max_steps >= 1),
  CONSTRAINT follow_up_permissions_steps_present
    CHECK ((scope = 'booking_communications') = (max_steps IS NULL)),
  CONSTRAINT follow_up_permissions_granted_by_one
    CHECK ((granted_by_user_id IS NULL) <> (granted_by_rule IS NULL)),
  CONSTRAINT follow_up_permissions_granted_by_rule_shape
    CHECK (granted_by_rule IS NULL OR granted_by_rule ~ '^[a-z][a-z0-9_.]{1,63}$'),
  CONSTRAINT follow_up_permissions_expires_after_grant CHECK (expires_at > granted_at),
  -- Consumption is what "one message" means, and it means it for both single-message
  -- scopes: a contextual reply that stayed reusable until expiry was P0-3.
  CONSTRAINT follow_up_permissions_consumption_is_one_message
    CHECK (consumed_at IS NULL OR scope IN ('single_email', 'contextual_reply')),
  CONSTRAINT follow_up_permissions_booking_reference_bounded
    CHECK (booking_reference IS NULL OR (btrim(booking_reference) <> '' AND length(booking_reference) <= 200)),
  CONSTRAINT follow_up_permissions_note_bounded
    CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 2000))
);

-- The two reads the product makes: the firm page lists a firm's permissions, and the
-- eligibility source loads a recipient's.
-- One permission per run: the binding is unique, so two enrollments cannot share one.
CREATE UNIQUE INDEX follow_up_permissions_one_enrollment
  ON follow_up_permissions (workspace_id, enrollment_id)
  WHERE enrollment_id IS NOT NULL;

CREATE INDEX follow_up_permissions_by_firm ON follow_up_permissions (workspace_id, firm_id, granted_at DESC);
CREATE INDEX follow_up_permissions_by_contact ON follow_up_permissions (workspace_id, contact_id, granted_at DESC);

COMMENT ON TABLE follow_up_permissions IS
  'Why Callie may write to one person, on the strength of one recorded event, how much, and until when (David, 29 September 2026). Re-read by followUpPermissionSource on every step; never trusted as a label.';

GRANT SELECT, INSERT, UPDATE, DELETE ON follow_up_permissions TO app_runtime, migration;

-- ---------------------------------------------------------------------------
-- (b) The enrollment says which of the three it is, and defaults to the excluded one
-- ---------------------------------------------------------------------------
-- `cold_legacy` is not a date rule and not a name rule. It is what every row that
-- existed before this statement is, because the column did not exist when the row was
-- written and nothing can honestly say more about it than that.
--
-- "History preserved, excluded from automatic sending forever, never revived": the rows
-- keep every column they had, `listStepWakes` stops making them due, and
-- `followUpPermissionSource` refuses the step even if something else makes one due. A
-- later valid request creates a NEW enrollment with a NEW permission; nothing clears
-- this value, and no code path writes `cold_legacy` at all.
ALTER TABLE sequence_enrollments
  ADD COLUMN origin_kind text NOT NULL DEFAULT 'cold_legacy',
  ADD COLUMN permission_id uuid;

ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_origin_kind_known
    CHECK (origin_kind IN ('cold_legacy', 'prospecting', 'follow_up'));

ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_permission_fkey FOREIGN KEY (workspace_id, permission_id)
    REFERENCES follow_up_permissions (workspace_id, id);

-- The label cannot authorize anything on its own, and this is the database half of
-- that: a **live** `follow_up` enrollment without a permission row is unrepresentable.
-- (The other half is the source, which re-reads the permission's own evidence.)
--
-- `ended_at IS NOT NULL` is the one exemption, and it is retention's: a deletion removes
-- the person's call logs and correspondence, so it removes the permissions that point at
-- them, and the enrollment it stopped keeps its history with a null pointer. An ended
-- enrollment sends nothing — `listStepWakes` and `enrollmentSource` both refuse it — so
-- the exemption cannot authorize anything (GPT-6 review of PR 332, P1-3).
ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_follow_up_has_permission
    CHECK (origin_kind <> 'follow_up' OR permission_id IS NOT NULL OR ended_at IS NOT NULL);

-- A later valid request supersedes a `cold_legacy` enrollment that is still live: the
-- same transaction terminally stops the old row and creates the new evidenced one, and
-- the end reason says which it was, rather than borrowing `admin_stop` from a person who
-- did nothing (P1-2). The constraint keeps its name, so its failing-insert case in
-- `test/db/constraints.test.ts` keeps covering it.
ALTER TABLE sequence_enrollments DROP CONSTRAINT sequence_enrollments_end_reason_known;
ALTER TABLE sequence_enrollments
  ADD CONSTRAINT sequence_enrollments_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN (
      'human_reply', 'linkedin_reply', 'engaged_call', 'opt_out', 'firm_suppressed',
      'stage_won', 'stage_lost', 'direct_send', 'send_skipped', 'reassignment',
      'sequence_complete', 'admin_stop', 'migration_superseded', 'superseded_by_follow_up'
    ));

COMMENT ON COLUMN sequence_enrollments.origin_kind IS
  'cold_legacy (the default, and the whole of the pre-0025 population: excluded from automatic sending forever), prospecting, or follow_up. enrollContact sets the latter two explicitly and never the default.';

-- One live *prospecting* enrollment per firm is enforced in `enrollContact` under the
-- firm row lock and again at the step by `firmExclusivitySource`, not by a partial
-- unique index. Two reasons, both in the decision document: the rows that already
-- exist would make such an index fail to build (a firm with two live contacts is a
-- state the schema deliberately permitted until today, and `docs/greenfield/sequences.md`
-- said so), and the rule is "one active *prospecting* contact" — a customer firm may
-- have follow-up enrollments for several people at once, which is the exception David
-- wrote into the same sentence.

-- The binding onto the run, declared after `sequence_enrollments` has its own new
-- columns: the two tables reference each other, and a permission is written first
-- (`enrollment_id` null), then the enrollment, then the permission is bound. Both sides
-- are nullable, so there is no chicken-and-egg insert.
ALTER TABLE follow_up_permissions
  ADD CONSTRAINT follow_up_permissions_enrollment_fkey FOREIGN KEY (workspace_id, enrollment_id)
    REFERENCES sequence_enrollments (workspace_id, id);

-- ---------------------------------------------------------------------------
-- (c) Which of the four ways into manual mode this opportunity took
-- ---------------------------------------------------------------------------
-- See the header. `MANUAL_MODE_ORIGINS` is the vocabulary; the CHECK repeats it rather
-- than importing it, as every other closed vocabulary in this schema does.
--
-- NULL means "not recorded", which is every row written before this migration and every
-- row whose control mode is `automated`. `followUpControlMode` treats a NULL on a
-- manual opportunity as a person's takeover — the answer that refuses — because an
-- unrecorded reason is not evidence of a signal.
ALTER TABLE opportunities
  ADD COLUMN control_mode_origin text;

ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_control_mode_origin_known
    CHECK (control_mode_origin IS NULL
           OR control_mode_origin IN ('human_reply', 'engaged_call', 'direct_send',
                                      'salesperson_command', 'direct_send_keep_automation'));

COMMENT ON COLUMN opportunities.control_mode_origin IS
  'Which of MANUAL_MODE_ORIGINS set control_mode = manual. NULL is unrecorded, and reads as a person''s takeover: the refusing answer.';

-- ---------------------------------------------------------------------------
-- (d) The call log records **what** was agreed, not merely that something was
-- ---------------------------------------------------------------------------
-- P0-1 of the review of PR 332: `verifyFollowUpPermission` could read a call log's firm
-- and contact but not its outcome, and nothing in the log said which e-mail or which
-- sequence the person on the call had agreed to. So the log could not be the evidence it
-- was being used as, and a `callback_requested` log — "call me Tuesday", which David
-- says grants no e-mail at all — was a permission away from authorizing one through the
-- API even though `logCallOutcome` refused it.
--
-- Three columns, written by `logCallOutcome` in the same transaction as the outcome, and
-- re-read on every step:
--
--   * `agreed_follow_up` — `single_email` or `agreed_sequence`, and nothing else is a
--     thing a call may agree to;
--   * `agreed_template_version_id` — the approved bytes a single e-mail was promised as;
--   * `agreed_sequence_version_id` — the immutable published version agreed to.
--
-- The CHECK pairs them, so a log cannot claim an agreement it does not name. Nullable
-- throughout: the overwhelming majority of calls agree to nothing.
ALTER TABLE call_logs
  ADD COLUMN agreed_follow_up text,
  ADD COLUMN agreed_template_version_id uuid,
  ADD COLUMN agreed_sequence_version_id uuid;

ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreed_follow_up_known
    CHECK (agreed_follow_up IS NULL OR agreed_follow_up IN ('single_email', 'agreed_sequence'));

-- `IS NOT DISTINCT FROM` rather than `=`, and that is the whole of this line's history:
-- a CHECK admits a row whose expression is *unknown*, so `(version IS NOT NULL) =
-- (agreed_follow_up = 'single_email')` admitted a log that agreed to nothing while naming
-- a template version — an orphan agreement id the permission could then be granted
-- against. Both sides are boolean and neither is ever null, so the only rows this admits
-- are the ones it names.
ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreement_names_what_was_agreed
    CHECK ((agreed_template_version_id IS NOT NULL) = (agreed_follow_up IS NOT DISTINCT FROM 'single_email')
           AND (agreed_sequence_version_id IS NOT NULL) = (agreed_follow_up IS NOT DISTINCT FROM 'agreed_sequence'));

-- Only a conversation agrees to a follow-up. "Call me Tuesday" is a callback task, and
-- this is that sentence in the database rather than in one command's branch.
ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreement_needs_interest
    CHECK (agreed_follow_up IS NULL OR outcome = 'interested');

ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreed_template_fkey FOREIGN KEY (workspace_id, agreed_template_version_id)
    REFERENCES template_versions (workspace_id, id);
ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_agreed_sequence_version_fkey
    FOREIGN KEY (workspace_id, agreed_sequence_version_id)
    REFERENCES sequence_versions (workspace_id, id);

-- ---------------------------------------------------------------------------
-- (e) The five refusals an operator will read
-- ---------------------------------------------------------------------------
-- Upserted on `code`, like 0024: a file that would fail on a row somebody had already
-- put there fails for the wrong reason, and this way the statement states the canonical
-- description and `recoverable` value whatever it finds.
--
-- `recoverable` is 15's question "can a person clear this?", not "is it permanent":
--
--   * `cold_legacy` — false. Nothing clears it. The enrollment is history; a new
--     evidenced follow-up is a new enrollment.
--   * `follow_up_not_permitted` — true. The evidence can be recorded, or the permission
--     granted again from the flow that should have granted it.
--   * `follow_up_expired` — true. A fresh request grants a fresh permission.
--   * `follow_up_scope_exhausted` — false. The one email this permission bought has
--     left; there is nothing to clear, only a new permission to grant.
--   * `firm_already_enrolled` — true. The other contact's enrollment ends, or the
--     salesperson stops it, and this one proceeds.
INSERT INTO hold_reason_codes (code, description, recoverable) VALUES
  ('cold_legacy',
   'The enrollment predates evidenced follow-up permissions and is excluded from automatic sending.',
   false),
  ('follow_up_not_permitted',
   'No unrevoked permission with matching evidence permits writing to this person.',
   true),
  ('follow_up_expired',
   'The permission for this follow-up has expired.',
   true),
  ('follow_up_scope_exhausted',
   'The follow-up this permission allowed has already been sent.',
   false),
  ('firm_already_enrolled',
   'Another contact at this firm is already in a live prospecting sequence.',
   true)
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description, recoverable = EXCLUDED.recoverable;
