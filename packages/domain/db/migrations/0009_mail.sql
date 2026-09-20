-- 0009_mail
--
-- Gmail synchronization, matching, classification effects and the immutable
-- template version (specification revision 3: sections 12.1 to 12.4, 12.6, 10.3,
-- 11.1 and Appendices A, C, F and G). Forward-only; this file never changes once
-- it has been applied anywhere. See docs/greenfield/migrations.md.
--
-- What it adds, and why each thing is its own table rather than a column:
--
--   * `mailboxes`, one personal Callie mailbox per salesperson (12.1), carrying the
--     compare-and-set history cursor and the coverage watermark of 12.3;
--   * `mailbox_tokens`, the envelope-encrypted refresh token, separate so that
--     departure is a DELETE of one row and Appendix F's "secret component only" is
--     a table-level fact rather than a promise about a column;
--   * `mailbox_watches`, one row per watch registration with its generation, so the
--     daily renewal of 12.3 and the two-days-to-expiry alarm of 13.3 read a row;
--   * `mailbox_recoveries`, one bounded full synchronization per generation, so
--     "the health hold clears only when the full interval is processed" is a
--     recorded fact and not a belief;
--   * `gmail_push_notifications`, the Pub/Sub message-id dedupe of 4.1;
--   * `mail_messages`, unique per mailbox and provider id (12.3), holding only the
--     header allowlist;
--   * `mail_message_bodies`, separate because the retention rule differs (10.3: 30
--     days for unmatched metadata, with the business record for a matched body) and
--     because "out-of-office bodies are not retained" is best expressed as the
--     absence of a row;
--   * `mail_message_matches`, one row per plausible open opportunity, which is what
--     makes the ambiguity protocol of 12.3 a set rather than a flag;
--   * `mail_message_classifications`, one row per layer, so G7b's model layer lands
--     beside the deterministic one and can never overwrite it;
--   * `mail_message_effects`, the business-uniqueness anchor Appendix C gives
--     `mail.sync`: replaying a history page applies each effect once;
--   * `template_versions`, the minimal immutable approved template G7-2 freezes on
--     to a fence and G8 extends with its own nullable columns (11.1).
--
-- Seeded rows would carry a named constant instant rather than now(). There are none.

-- ---------------------------------------------------------------------------
-- mailboxes (specification 12.1, 12.3, Appendix A "Mail-sync page")
--
-- One per salesperson: `mailboxes_one_per_owner`. The shared kind is reserved by
-- the CHECK that names it and disabled by the CHECK beside it, which is how 12.1's
-- "a shared-mailbox kind is reserved and disabled" survives a later release — the
-- second CHECK is dropped and the vocabulary does not have to be invented again.
--
-- The cursor and the watermark live here rather than in a table of their own
-- because the compare-and-set of 12.3 is `UPDATE ... WHERE history_id IS NOT
-- DISTINCT FROM $old`, and a single-row update is the whole of it. `generation` is
-- the monotonic counter Appendix C's `watch:{mailbox}:{generation}` and
-- `mail-recover:{mailbox}:{generation}` keys compose with; it never decreases.
--
-- `coverage_watermark_at` is "the instant through which every relevant message is
-- known processed". It may not exist without a cursor: a watermark with no cursor
-- would claim coverage that nothing could have proved.
-- ---------------------------------------------------------------------------
CREATE TABLE mailboxes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  owner_user_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'personal',
  email_address text NOT NULL,
  -- Gmail's own identifier for the account, from users.getProfile. Never a token.
  provider_account_id text,
  status text NOT NULL DEFAULT 'connected',
  generation integer NOT NULL DEFAULT 1,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  disconnect_reason text,
  sync_state text NOT NULL DEFAULT 'baseline_pending',
  history_id text,
  history_id_updated_at timestamptz,
  coverage_watermark_at timestamptz,
  baseline_from_at timestamptz,
  baseline_completed_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailboxes_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailboxes_owner_fkey FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT mailboxes_one_per_owner UNIQUE (workspace_id, owner_user_id),
  CONSTRAINT mailboxes_one_per_address UNIQUE (workspace_id, email_address),
  CONSTRAINT mailboxes_kind_known CHECK (kind IN ('personal', 'shared')),
  -- 12.1: "A shared-mailbox kind is reserved and disabled."
  CONSTRAINT mailboxes_shared_kind_disabled CHECK (kind = 'personal'),
  CONSTRAINT mailboxes_status_known CHECK (status IN ('connected', 'disconnected', 'revoked')),
  -- Canonical means lower-cased, the spelling the suppression canonicalizer and
  -- `email_addresses` both produce, so a comparison needs no second rule.
  CONSTRAINT mailboxes_address_shape
    CHECK (email_address = lower(email_address)
           AND email_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           AND length(email_address) <= 320),
  CONSTRAINT mailboxes_provider_account_shape
    CHECK (provider_account_id IS NULL
           OR (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 320)),
  CONSTRAINT mailboxes_generation_positive CHECK (generation >= 1),
  CONSTRAINT mailboxes_sync_state_known CHECK (sync_state IN ('baseline_pending', 'ready', 'recovering')),
  CONSTRAINT mailboxes_disconnect_consistent CHECK ((status = 'connected') = (disconnected_at IS NULL)),
  CONSTRAINT mailboxes_disconnect_reason_bounded
    CHECK (disconnect_reason IS NULL OR (btrim(disconnect_reason) <> '' AND length(disconnect_reason) <= 200)),
  -- A Gmail history id is a decimal integer. Storing it as text keeps it exact: it
  -- outgrows a 32-bit integer and comparing it is never arithmetic.
  CONSTRAINT mailboxes_history_id_shape CHECK (history_id IS NULL OR history_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT mailboxes_history_cursor_consistent
    CHECK ((history_id IS NULL) = (history_id_updated_at IS NULL)),
  CONSTRAINT mailboxes_coverage_needs_cursor
    CHECK (coverage_watermark_at IS NULL OR history_id IS NOT NULL),
  CONSTRAINT mailboxes_baseline_consistent
    CHECK (baseline_completed_at IS NULL OR baseline_from_at IS NOT NULL),
  -- 12.3: "A newly connected mailbox completes a bounded baseline ... before
  -- automation begins." Ready means the baseline finished.
  CONSTRAINT mailboxes_ready_has_baseline
    CHECK (sync_state <> 'ready' OR baseline_completed_at IS NOT NULL),
  CONSTRAINT mailboxes_last_sync_error_bounded
    CHECK (last_sync_error IS NULL OR (btrim(last_sync_error) <> '' AND length(last_sync_error) <= 500)),
  CONSTRAINT mailboxes_updated_not_before_created CHECK (updated_at >= created_at)
);

CREATE INDEX mailboxes_connected ON mailboxes (workspace_id, status) WHERE status = 'connected';

-- ---------------------------------------------------------------------------
-- mailbox_tokens (specification invariant 6, 10.3, Appendix F)
--
-- "Refresh tokens are envelope-encrypted." The plaintext never reaches this
-- database and never reaches a log: the row holds the wrapped data key, the
-- ciphertext, the nonce and the tag, and the key that unwraps the data key lives in
-- KMS (`infra/modules/secrets`, `aws_kms_key.envelope`).
--
-- Its own table for two reasons. Appendix F gives refresh-token plaintext its own
-- visibility class, and 10.3's "departure ... deletes refresh-token material" is
-- then one DELETE that leaves every business fact about the mailbox in place.
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_tokens (
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  -- The KMS key the data key is wrapped under, or the local fake's own name. A
  -- public identifier: an ARN or an alias, never key material.
  key_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'aes-256-gcm',
  wrapped_data_key bytea NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  CONSTRAINT mailbox_tokens_pkey PRIMARY KEY (workspace_id, mailbox_id),
  CONSTRAINT mailbox_tokens_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mailbox_tokens_key_id_bounded CHECK (btrim(key_id) <> '' AND length(key_id) <= 300),
  CONSTRAINT mailbox_tokens_algorithm_known CHECK (algorithm = 'aes-256-gcm'),
  CONSTRAINT mailbox_tokens_wrapped_key_present CHECK (octet_length(wrapped_data_key) BETWEEN 1 AND 4096),
  CONSTRAINT mailbox_tokens_ciphertext_present CHECK (octet_length(ciphertext) BETWEEN 1 AND 8192),
  -- AES-GCM: a 96-bit nonce and a 128-bit tag. A wrong length is a wrong algorithm.
  CONSTRAINT mailbox_tokens_iv_length CHECK (octet_length(iv) = 12),
  CONSTRAINT mailbox_tokens_auth_tag_length CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT mailbox_tokens_rotated_not_before_created CHECK (rotated_at IS NULL OR rotated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- mailbox_watches (specification 12.3, 13.3, Appendix C "Watch renewal")
--
-- "Gmail watch is renewed daily; an alarm fires within two days of expiry." A
-- renewal cancels the current row and inserts the next generation in one
-- transaction, so `mailbox_watches_one_current` is what stops two live watches for
-- one mailbox, and the generation is what stops a late renewal from overwriting a
-- newer one (Appendix C calls that protection a fencing token, and it is).
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_watches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  generation integer NOT NULL,
  topic_name text NOT NULL,
  provider_history_id text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  cancelled_reason text,
  CONSTRAINT mailbox_watches_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailbox_watches_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mailbox_watches_one_per_generation UNIQUE (workspace_id, mailbox_id, generation),
  CONSTRAINT mailbox_watches_generation_positive CHECK (generation >= 1),
  -- The fully qualified Pub/Sub topic `infra/modules/pubsub` outputs.
  CONSTRAINT mailbox_watches_topic_shape
    CHECK (topic_name ~ '^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/topics/[A-Za-z0-9._~%+-]{3,255}$'),
  CONSTRAINT mailbox_watches_history_id_shape
    CHECK (provider_history_id IS NULL OR provider_history_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT mailbox_watches_expiry_after_registration CHECK (expires_at > registered_at),
  CONSTRAINT mailbox_watches_cancellation_consistent
    CHECK ((cancelled_at IS NULL) = (cancelled_reason IS NULL)),
  CONSTRAINT mailbox_watches_cancelled_reason_bounded
    CHECK (cancelled_reason IS NULL OR (btrim(cancelled_reason) <> '' AND length(cancelled_reason) <= 200)),
  CONSTRAINT mailbox_watches_cancelled_not_before_registration
    CHECK (cancelled_at IS NULL OR cancelled_at >= registered_at)
);

CREATE UNIQUE INDEX mailbox_watches_one_current
  ON mailbox_watches (workspace_id, mailbox_id)
  WHERE cancelled_at IS NULL;

CREATE INDEX mailbox_watches_by_expiry
  ON mailbox_watches (workspace_id, expires_at)
  WHERE cancelled_at IS NULL;

-- ---------------------------------------------------------------------------
-- mailbox_recoveries (specification 12.3, Appendix C "Mail recovery", Appendix G 13)
--
-- The bounded full synchronization an expired history cursor forces: "from the
-- earlier of watermark minus one hour and the oldest unresolved outbound message or
-- active enrollment, using epoch-second after: and before: bounds, 500 IDs per
-- page, and every page. The health hold clears only when the full interval is
-- processed."
--
-- One row per `(mailbox, generation)`, which is exactly Appendix C's idempotency
-- key, so a replayed recovery job continues the row it already has. `completed_at`
-- is the proof the coverage hold reads; `hold_id` is the hold it will release.
-- ---------------------------------------------------------------------------
CREATE TABLE mailbox_recoveries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  generation integer NOT NULL,
  reason text NOT NULL,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  pages_completed integer NOT NULL DEFAULT 0,
  messages_seen integer NOT NULL DEFAULT 0,
  hold_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT mailbox_recoveries_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mailbox_recoveries_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mailbox_recoveries_hold_fkey FOREIGN KEY (workspace_id, hold_id)
    REFERENCES active_holds (workspace_id, id),
  CONSTRAINT mailbox_recoveries_one_per_generation UNIQUE (workspace_id, mailbox_id, generation),
  CONSTRAINT mailbox_recoveries_generation_positive CHECK (generation >= 1),
  CONSTRAINT mailbox_recoveries_reason_known CHECK (reason IN ('baseline', 'history_expired', 'restore')),
  CONSTRAINT mailbox_recoveries_interval_ordered CHECK (to_at > from_at),
  CONSTRAINT mailbox_recoveries_pages_not_negative CHECK (pages_completed >= 0),
  CONSTRAINT mailbox_recoveries_messages_not_negative CHECK (messages_seen >= 0),
  CONSTRAINT mailbox_recoveries_completed_not_before_started
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

-- ---------------------------------------------------------------------------
-- gmail_push_notifications (specification 4.1, Appendix G 10)
--
-- "Deduplicates message IDs; rejects unknown or inactive mailboxes; coalesces
-- repeated notifications into one mailbox sync stream; and acknowledges only after
-- durable recording or enqueueing."
--
-- The row is written only after the push token has been validated and the mailbox
-- has resolved, so the dedupe key is workspace-scoped: two workspaces receiving the
-- same Pub/Sub message id is Appendix G 8, and neither may hide the other's.
-- `job_id` is the `mail.sync` this notification coalesced into, which is what makes
-- "acknowledge only after durable enqueue" checkable after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE gmail_push_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  history_id text,
  published_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid,
  CONSTRAINT gmail_push_notifications_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT gmail_push_notifications_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT gmail_push_notifications_job_fkey FOREIGN KEY (workspace_id, job_id)
    REFERENCES jobs (workspace_id, id),
  CONSTRAINT gmail_push_notifications_one_per_message UNIQUE (workspace_id, provider_message_id),
  CONSTRAINT gmail_push_notifications_message_id_bounded
    CHECK (btrim(provider_message_id) <> '' AND length(provider_message_id) <= 200),
  CONSTRAINT gmail_push_notifications_history_id_shape
    CHECK (history_id IS NULL OR history_id ~ '^[0-9]{1,20}$')
);

-- ---------------------------------------------------------------------------
-- mail_messages (specification 12.3, 10.3, Appendix A "Mail-sync page")
--
-- "Message uniqueness per mailbox and provider id" is
-- `mail_messages_one_per_provider_id`, and it is per workspace as well, so two
-- workspaces observing the same Gmail id never collide (Appendix G 8).
--
-- The columns are the header allowlist of 12.3 and nothing else: From, To, Cc,
-- Subject, Date, Message-ID, References, In-Reply-To, Auto-Submitted and List-Id.
-- There is no raw MIME column: 10.3 gives raw MIME at most seven days, and this
-- table is not where a seven-day thing lives.
--
-- `attachment_references` is metadata only — filename, media type, size, hash and
-- the Gmail reference (10.3: "Attachments are not copied into FSS"). It is jsonb
-- rather than a table because nothing in version one queries across attachments,
-- and a CHECK that refuses anything but a bounded array is the whole contract.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  provider_thread_id text NOT NULL,
  -- The RFC 5322 Message-ID, stored without its angle brackets so a References
  -- header and a fence's deterministic id compare without a second rule.
  rfc_message_id text,
  direction text NOT NULL,
  internal_date timestamptz NOT NULL,
  header_from text,
  header_to text[] NOT NULL DEFAULT '{}',
  header_cc text[] NOT NULL DEFAULT '{}',
  subject text,
  reference_message_ids text[] NOT NULL DEFAULT '{}',
  in_reply_to text,
  auto_submitted text,
  list_id text,
  label_ids text[] NOT NULL DEFAULT '{}',
  attachment_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- False once a body has been fetched, which happens only after a plausible match.
  metadata_only boolean NOT NULL DEFAULT true,
  matched boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_messages_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_messages_mailbox_fkey FOREIGN KEY (workspace_id, mailbox_id)
    REFERENCES mailboxes (workspace_id, id),
  CONSTRAINT mail_messages_one_per_provider_id UNIQUE (workspace_id, mailbox_id, provider_message_id),
  CONSTRAINT mail_messages_provider_id_shape CHECK (provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT mail_messages_thread_id_shape CHECK (provider_thread_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT mail_messages_rfc_id_shape
    CHECK (rfc_message_id IS NULL
           OR (btrim(rfc_message_id) <> ''
               AND length(rfc_message_id) <= 998
               AND rfc_message_id !~ '[<>[:space:]]')),
  CONSTRAINT mail_messages_direction_known CHECK (direction IN ('incoming', 'outgoing')),
  CONSTRAINT mail_messages_from_canonical
    CHECK (header_from IS NULL OR (header_from = lower(header_from) AND length(header_from) <= 320)),
  CONSTRAINT mail_messages_subject_bounded CHECK (subject IS NULL OR length(subject) <= 998),
  CONSTRAINT mail_messages_in_reply_to_shape
    CHECK (in_reply_to IS NULL OR (length(in_reply_to) <= 998 AND in_reply_to !~ '[<>[:space:]]')),
  CONSTRAINT mail_messages_auto_submitted_bounded
    CHECK (auto_submitted IS NULL OR length(auto_submitted) <= 200),
  CONSTRAINT mail_messages_list_id_bounded CHECK (list_id IS NULL OR length(list_id) <= 200),
  CONSTRAINT mail_messages_references_bounded CHECK (cardinality(reference_message_ids) <= 100),
  CONSTRAINT mail_messages_recipients_bounded
    CHECK (cardinality(header_to) <= 200 AND cardinality(header_cc) <= 200),
  CONSTRAINT mail_messages_labels_bounded CHECK (cardinality(label_ids) <= 100),
  CONSTRAINT mail_messages_attachments_are_array
    CHECK (jsonb_typeof(attachment_references) = 'array' AND jsonb_array_length(attachment_references) <= 100),
  -- A body is a body of a matched message. `metadata_only = false` without a match
  -- would be a body fetched before 12.3 permits one.
  CONSTRAINT mail_messages_body_needs_match CHECK (metadata_only OR matched)
);

-- One RFC Message-ID per mailbox, when there is one: 12.3 matches "Message-ID
-- references against FSS fences", and two rows claiming one id would make that
-- match ambiguous for a reason that has nothing to do with the prospect.
CREATE UNIQUE INDEX mail_messages_one_per_rfc_id
  ON mail_messages (workspace_id, mailbox_id, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

CREATE INDEX mail_messages_by_thread ON mail_messages (workspace_id, mailbox_id, provider_thread_id);
CREATE INDEX mail_messages_unmatched ON mail_messages (workspace_id, recorded_at) WHERE NOT matched;

-- ---------------------------------------------------------------------------
-- mail_message_bodies (specification 10.3, 12.3, 12.4)
--
-- A body exists only for a message that plausibly matched, and an out-of-office
-- body is never written at all. Deleting the body is then a DELETE of one row and
-- leaves the metadata the 30-day rule governs where it is.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_message_bodies (
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  body_text text NOT NULL,
  -- A body the fetch truncated cannot prove an opt-out: the sentence may continue.
  truncated boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_bodies_pkey PRIMARY KEY (workspace_id, mail_message_id),
  CONSTRAINT mail_message_bodies_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_message_bodies_text_bounded CHECK (length(body_text) <= 200000)
);

-- ---------------------------------------------------------------------------
-- mail_message_matches (specification 12.3, Appendix G 14 and 15)
--
-- "Multiple plausible firms create an ambiguous message, active holds on every
-- plausible open opportunity, and reply-lane cards. Resolution makes the selected
-- opportunity manual when human and releases only the ambiguity holds on other
-- candidates after a fresh check."
--
-- So a match is a row per candidate rather than a column on the message, an
-- ambiguous candidate must carry the hold it opened, and resolution writes
-- `selected` on every candidate at once — the losers as false, not as deletions.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_message_matches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  contact_id uuid,
  match_rule text NOT NULL,
  ambiguous boolean NOT NULL DEFAULT false,
  hold_id uuid,
  selected boolean,
  resolved_at timestamptz,
  resolved_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_matches_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_message_matches_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_message_matches_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT mail_message_matches_contact_fkey FOREIGN KEY (workspace_id, contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT mail_message_matches_hold_fkey FOREIGN KEY (workspace_id, hold_id)
    REFERENCES active_holds (workspace_id, id),
  CONSTRAINT mail_message_matches_resolver_fkey FOREIGN KEY (workspace_id, resolved_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT mail_message_matches_one_per_opportunity UNIQUE (workspace_id, mail_message_id, opportunity_id),
  -- 12.3's matching order, in the order it is tried.
  CONSTRAINT mail_message_matches_rule_known
    CHECK (match_rule IN ('thread', 'message_id_reference', 'participant')),
  CONSTRAINT mail_message_matches_ambiguous_has_hold CHECK (NOT ambiguous OR hold_id IS NOT NULL),
  CONSTRAINT mail_message_matches_resolution_consistent CHECK ((resolved_at IS NULL) = (selected IS NULL)),
  CONSTRAINT mail_message_matches_resolver_resolved
    CHECK (resolved_by_user_id IS NULL OR resolved_at IS NOT NULL)
);

CREATE INDEX mail_message_matches_by_opportunity
  ON mail_message_matches (workspace_id, opportunity_id, created_at);

-- Only one candidate may win. A second `selected = true` for one message would be
-- two resolutions of one ambiguity, which Appendix A calls "one resolution per
-- message".
CREATE UNIQUE INDEX mail_message_matches_one_selected
  ON mail_message_matches (workspace_id, mail_message_id)
  WHERE selected;

-- ---------------------------------------------------------------------------
-- mail_message_classifications (specification 12.4)
--
-- One row per layer. The deterministic layer is written by `mail.sync`; the model
-- layer is G7b's, and it lands beside the deterministic row rather than over it.
--
-- `mail_message_classifications_model_cannot_decide` is 12.4 in the database: the
-- model "may label and prioritize ordinary work but cannot by itself release a
-- message as automated, close an opportunity, create a suppression from ambiguous
-- language ... or resume automation". A model row may therefore only ever say
-- `uncertain`. Its disposition is a suggestion and its confidence is a number;
-- neither is a class.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_message_classifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  layer text NOT NULL,
  class text NOT NULL,
  suggested_disposition text,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_confirmation boolean NOT NULL,
  rules_version text NOT NULL,
  model_name text,
  prompt_version text,
  confidence numeric(4, 3),
  classified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_classifications_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_message_classifications_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_message_classifications_one_per_layer UNIQUE (workspace_id, mail_message_id, layer),
  CONSTRAINT mail_message_classifications_layer_known CHECK (layer IN ('deterministic', 'model')),
  CONSTRAINT mail_message_classifications_class_known
    CHECK (class IN ('human', 'uncertain', 'automated', 'bounce', 'opt_out')),
  CONSTRAINT mail_message_classifications_disposition_known
    CHECK (suggested_disposition IS NULL
           OR suggested_disposition IN ('interested', 'referral_or_wrong_person', 'follow_up_later',
                                        'not_interested', 'opt_out', 'other')),
  CONSTRAINT mail_message_classifications_signals_are_array CHECK (jsonb_typeof(signals) = 'array'),
  CONSTRAINT mail_message_classifications_rules_version_shape CHECK (rules_version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT mail_message_classifications_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT mail_message_classifications_model_fields_are_the_model_layer
    CHECK ((layer = 'model') OR (model_name IS NULL AND prompt_version IS NULL AND confidence IS NULL)),
  CONSTRAINT mail_message_classifications_model_is_versioned
    CHECK (layer <> 'model' OR (model_name IS NOT NULL AND prompt_version IS NOT NULL)),
  CONSTRAINT mail_message_classifications_model_cannot_decide
    CHECK (layer <> 'model' OR class = 'uncertain')
);

-- ---------------------------------------------------------------------------
-- mail_message_effects (specification 12.4, Appendix C "Mail sync")
--
-- Appendix C protects `mail.sync` by "message uniqueness and cursor CAS". Message
-- uniqueness stops a message being recorded twice; it does not by itself stop the
-- *effects* of a message being applied twice, because a page may be replayed after
-- the messages on it already exist. This table is that second half: one row per
-- (message, effect kind, target), so applying an effect is an insert that either
-- happens or finds itself already done.
--
-- UPDATE is revoked. An effect is a record of something that happened; correcting
-- it is another effect, never a rewrite of this one.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_message_effects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  effect_kind text NOT NULL,
  target_key text NOT NULL,
  hold_id uuid,
  suppression_event_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_message_effects_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_message_effects_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_message_effects_hold_fkey FOREIGN KEY (workspace_id, hold_id)
    REFERENCES active_holds (workspace_id, id),
  CONSTRAINT mail_message_effects_suppression_fkey FOREIGN KEY (workspace_id, suppression_event_id)
    REFERENCES suppression_events (workspace_id, event_id),
  CONSTRAINT mail_message_effects_one_per_target
    UNIQUE (workspace_id, mail_message_id, effect_kind, target_key),
  CONSTRAINT mail_message_effects_kind_known
    CHECK (effect_kind IN ('hold_opened', 'opportunity_manual', 'route_invalidated',
                           'handle_suppressed', 'firm_suppressed', 'reply_lane_entry',
                           'direct_send_manual', 'no_effect')),
  CONSTRAINT mail_message_effects_target_bounded
    CHECK (btrim(target_key) <> '' AND length(target_key) <= 200),
  CONSTRAINT mail_message_effects_detail_is_object CHECK (jsonb_typeof(detail) = 'object'),
  -- An effect that says a hold opened names the hold, and one that says an address
  -- was suppressed names the event. Otherwise the record proves nothing.
  CONSTRAINT mail_message_effects_hold_named CHECK (effect_kind <> 'hold_opened' OR hold_id IS NOT NULL),
  CONSTRAINT mail_message_effects_suppression_named
    CHECK (effect_kind NOT IN ('handle_suppressed', 'firm_suppressed') OR suppression_event_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- template_versions (specification 11.1, 12.6)
--
-- The minimal immutable approved template. G7-2 freezes one on to every outbound
-- fence; G8 owns sequences and extends this table with its own nullable columns
-- (11.1 reserves `personalization_strategy`, generator and prompt version, evidence
-- ids and the generated block). It is here, one pull request early, so that G8
-- extends a table that exists rather than racing G7-2 to create one.
--
-- Two rules are the database's rather than the code's.
--
-- `template_versions_no_unsubscribe_link`: David's decision and 12.6 — "Every
-- automated template's approved footer explains how to stop by replying. No web
-- unsubscribe link is included." A template mentioning an unsubscribe link is
-- refused outright rather than caught by a reviewer.
--
-- `template_versions_approved_has_stop_line`: an approved body carries the
-- reply-to-stop sentence. The exact sentence is `SENDING_STOP_LINE` in
-- `packages/domain/src/rules/templates.ts`, which is also what binds the content
-- hash; the CHECK asserts the part of it that can never move.
-- ---------------------------------------------------------------------------
CREATE TABLE template_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  template_id uuid NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  content_hash text NOT NULL,
  footer_sign_off text NOT NULL,
  footer_postal_address text NOT NULL,
  required_variables text[] NOT NULL DEFAULT '{}',
  approved_at timestamptz,
  approved_by_user_id uuid,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_versions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT template_versions_approver_fkey FOREIGN KEY (workspace_id, approved_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT template_versions_one_per_version UNIQUE (workspace_id, template_id, version),
  CONSTRAINT template_versions_version_positive CHECK (version >= 1),
  CONSTRAINT template_versions_name_bounded CHECK (btrim(name) <> '' AND length(name) <= 200),
  CONSTRAINT template_versions_subject_bounded CHECK (btrim(subject) <> '' AND length(subject) <= 160),
  CONSTRAINT template_versions_body_bounded CHECK (btrim(body) <> '' AND length(body) <= 4000),
  CONSTRAINT template_versions_content_hash_shape CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT template_versions_sign_off_bounded
    CHECK (btrim(footer_sign_off) <> '' AND length(footer_sign_off) <= 300),
  CONSTRAINT template_versions_postal_address_bounded
    CHECK (btrim(footer_postal_address) <> '' AND length(footer_postal_address) <= 200),
  CONSTRAINT template_versions_variables_bounded CHECK (cardinality(required_variables) <= 50),
  CONSTRAINT template_versions_approval_consistent
    CHECK ((approved_at IS NULL) = (approved_by_user_id IS NULL)),
  CONSTRAINT template_versions_no_unsubscribe_link
    CHECK (body !~* 'unsubscribe' AND subject !~* 'unsubscribe'),
  CONSTRAINT template_versions_approved_has_stop_line
    CHECK (approved_at IS NULL OR position('Reply "stop"' IN body) > 0),
  CONSTRAINT template_versions_retired_not_before_created CHECK (retired_at IS NULL OR retired_at >= created_at),
  CONSTRAINT template_versions_updated_not_before_created CHECK (updated_at >= created_at)
);

-- 11.1: "Draft versions may change; published versions and steps are immutable by
-- trigger. Editing a published sequence creates a new draft." The same rule for a
-- template version: once approved, the bytes that may be sent cannot move, because
-- the approval is an approval of those bytes and of nothing else.
CREATE FUNCTION assert_approved_template_immutable() RETURNS trigger
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
     OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN
    RAISE EXCEPTION 'an approved template version is immutable; publish a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER template_versions_approved_immutable
  BEFORE UPDATE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION assert_approved_template_immutable();

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then. Each table here needs its own grant.
--
-- `mailbox_tokens` keeps DELETE: 10.3's "departure ... deletes refresh-token
-- material" is that DELETE.
--
-- `mail_message_effects` has UPDATE revoked: an effect records what happened, and a
-- correction is another effect rather than a rewrite of this one. DELETE stays,
-- because the documented deletion workflow of 10.3 has to be able to remove a
-- firm's correspondence.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON mailboxes TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailbox_tokens TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailbox_watches TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailbox_recoveries TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON gmail_push_notifications TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_messages TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_message_bodies TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_message_matches TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_message_classifications TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON template_versions TO app_runtime, migration;

GRANT SELECT, INSERT, DELETE ON mail_message_effects TO app_runtime, migration;
REVOKE UPDATE, TRUNCATE ON mail_message_effects FROM app_runtime, migration;
