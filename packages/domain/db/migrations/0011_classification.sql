-- ---------------------------------------------------------------------------
-- 0011_classification.sql — the model layer of reply classification (lane G7b)
--
-- Specification 8.3, 12.4, Appendix A rows "Record uncertain or ambiguous reply"
-- and "Confirm disposition", Appendix G 34 and 35, and 13.4's cost line.
--
-- Migration 0009 already created `mail_message_classifications` with a `model`
-- layer and the one constraint that matters most:
--
--     mail_message_classifications_model_cannot_decide
--       CHECK (layer <> 'model' OR class = 'uncertain')
--
-- Everything here is built on top of that sentence rather than beside it. The model
-- writes a second opinion, in a row the database will not let say anything but
-- `uncertain`; a *person* writes the decision, in `mail_reply_confirmations`, whose
-- `confirmed_by_user_id` is NOT NULL and references a membership. Those two facts
-- together are 12.4's authority boundary in the schema: "The LLM may label and
-- prioritize ordinary work but cannot by itself release a message as automated,
-- close an opportunity, create a suppression from ambiguous language, commit an
-- extracted callback instant, or resume automation."
--
-- Three tables and three columns:
--
--   * `mail_message_classifications` gains `supporting_excerpt`, `callback_proposal`
--     and `effort`, all nullable, all forbidden outside the model layer. Additive,
--     so the binaries of the release before this one accept the shape unchanged
--     (4.2, expand).
--   * `classifier_settings`, one row per workspace: which model, which effort, and
--     whether the classifier runs at all. David chooses the model at launch, so it
--     is configuration and never a literal at a call site.
--   * `mail_classification_calls`, append-only: model, prompt version, input,
--     cached and output tokens, latency and outcome for every attempt, so 13.4's
--     dashboard can show cost and drift. No prompt text and no message text.
--   * `mail_reply_confirmations`, append-only: the salesperson's confirmed or
--     corrected disposition and the consequences it permitted (8.3).
--
-- Seeded rows would carry a named constant instant rather than now(). There are
-- none: `classifier_settings` keeps its defaults in its column defaults, and a row
-- appears the first time an admin writes one.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- mail_message_classifications: the three columns the model layer needs (12.4)
--
-- `supporting_excerpt` is the verbatim substring the model quoted. The adapter
-- verifies it against the input before the row is written — a "quote" that is not in
-- the message is a fabrication, and it makes the whole suggestion unusable — so the
-- column holds something a reader can find in the message they are looking at.
--
-- `callback_proposal` is 12.4's "extracted callback proposal": local date-time text
-- and a zone, as the model read them. It is a proposal in the strongest sense — the
-- model "cannot by itself commit an extracted callback instant" — so this column is
-- the only place it may appear until a person confirms it, and confirming writes a
-- `callbacks` row through G4's `createCallback`, which refuses a non-user actor.
--
-- `effort` is `output_config.effort` as sent. It is recorded beside the model name
-- because the two together are what a result is reproducible against: the same
-- prompt at `low` and at `max` is not the same experiment. It is null for a model
-- that does not take the parameter.
-- ---------------------------------------------------------------------------
ALTER TABLE mail_message_classifications
  ADD COLUMN supporting_excerpt text,
  ADD COLUMN callback_proposal jsonb,
  ADD COLUMN effort text;

ALTER TABLE mail_message_classifications
  ADD CONSTRAINT mail_message_classifications_suggestion_is_the_model_layer
    CHECK ((layer = 'model')
           OR (supporting_excerpt IS NULL AND callback_proposal IS NULL AND effort IS NULL)),
  ADD CONSTRAINT mail_message_classifications_excerpt_bounded
    CHECK (supporting_excerpt IS NULL
           OR (btrim(supporting_excerpt) <> '' AND length(supporting_excerpt) <= 500)),
  ADD CONSTRAINT mail_message_classifications_callback_proposal_is_object
    CHECK (callback_proposal IS NULL OR jsonb_typeof(callback_proposal) = 'object'),
  ADD CONSTRAINT mail_message_classifications_effort_known
    CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max'));

-- The worker's "which messages still need a second opinion" read: deterministic
-- rows that said `uncertain` and have no model row beside them. Partial and *not*
-- unique — a unique partial index here would be a second uniqueness claim over a
-- table that already has `mail_message_classifications_one_per_layer`.
CREATE INDEX mail_message_classifications_uncertain_deterministic
  ON mail_message_classifications (workspace_id, mail_message_id)
  WHERE layer = 'deterministic' AND class = 'uncertain';

-- ---------------------------------------------------------------------------
-- classifier_settings (specification 10.1, 12.4)
--
-- 10.1 makes versioned configuration an admin's: "Admins maintain versioned state
-- postures, call windows, approved template versions ... research limits". The model
-- id and the effort belong in the same place and for the same reason — the choice
-- between Claude Opus 5 and Claude Haiku 4.5 is made at launch, and a choice made at
-- launch is configuration, never a literal in the call site.
--
-- `classifier_settings_model_known` is an allow-list rather than a shape check, for
-- two reasons. A typo in a model id is a request that fails at the provider and
-- costs a retry ladder; and the adapter knows per-model facts — Claude Haiku 4.5
-- rejects `output_config.effort`, Claude Opus 5 takes the server-side `fallbacks`
-- parameter — that it can only know about models it has been told about.
--
-- `classifier_settings_model_has_no_date_suffix` is the rule the model
-- documentation states: the ids above are complete as they are, and a remembered
-- `-20251001` suffix is a refusal at the provider rather than a pin.
--
-- `enabled = false` is the workspace-level half of the classifier's off switch; the
-- process-level half is the `FSS_CLASSIFIER` environment variable the worker reads.
-- Either one off means every message stays `uncertain` and no request is sent.
-- ---------------------------------------------------------------------------
CREATE TABLE classifier_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  enabled boolean NOT NULL DEFAULT true,
  model_name text NOT NULL DEFAULT 'claude-opus-5',
  effort text NOT NULL DEFAULT 'low',
  max_output_tokens integer NOT NULL DEFAULT 512,
  -- 13.4 shows cost; this is the bound that keeps it small. Counted per workspace
  -- business date from `mail_classification_calls`.
  daily_call_cap integer NOT NULL DEFAULT 500,
  updated_by_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classifier_settings_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT classifier_settings_updater_fkey FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT classifier_settings_model_known
    CHECK (model_name IN ('claude-opus-5', 'claude-haiku-4-5')),
  CONSTRAINT classifier_settings_model_has_no_date_suffix
    CHECK (model_name !~ '-20[0-9]{6}$'),
  CONSTRAINT classifier_settings_effort_known
    CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  CONSTRAINT classifier_settings_output_bounded
    CHECK (max_output_tokens BETWEEN 64 AND 4096),
  CONSTRAINT classifier_settings_cap_bounded
    CHECK (daily_call_cap BETWEEN 0 AND 100000)
);

-- ---------------------------------------------------------------------------
-- mail_classification_calls (specification 13.4; "every call records ...")
--
-- One row per attempt, append-only. UPDATE and TRUNCATE are revoked for the reason
-- they are on `mail_message_effects`: this is a record of something that happened,
-- and a correction is another row.
--
-- `request_sent` is what makes the table honest about the attempts that never
-- reached the provider — the classifier switched off, the daily cap reached, the
-- deterministic layer having already decided. Those rows carry zero tokens and zero
-- latency, and a CHECK says so rather than trusting the writer, because a dashboard
-- that showed a cost for a classifier nobody switched on would be worse than one
-- that showed nothing.
--
-- The outcomes are the ways a call can fail to produce a usable suggestion, and
-- every one of them leaves the message `uncertain`:
--
--   `refusal`            — `stop_reason = "refusal"`; the category is recorded.
--   `malformed`          — nothing parseable came back.
--   `schema_invalid`     — it parsed and did not satisfy the strict schema.
--   `excerpt_unverified` — the quoted excerpt is not a substring of the input.
--   `provider_error`     — the SDK raised.
--
-- Nothing here holds prompt text, message text or an excerpt. The whole table is
-- counts, ids and outcomes, so an operational record kept for the dashboard never
-- becomes a second copy of somebody's correspondence (10.3).
-- ---------------------------------------------------------------------------
CREATE TABLE mail_classification_calls (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  model_name text NOT NULL,
  prompt_version text NOT NULL,
  effort text,
  request_sent boolean NOT NULL,
  outcome text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  stop_reason text,
  refusal_category text,
  business_date date NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_classification_calls_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_classification_calls_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_classification_calls_outcome_known
    CHECK (outcome IN ('accepted', 'refusal', 'malformed', 'schema_invalid', 'excerpt_unverified',
                       'provider_error', 'disabled', 'capped', 'not_applicable')),
  CONSTRAINT mail_classification_calls_effort_known
    CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  CONSTRAINT mail_classification_calls_prompt_version_shape
    CHECK (prompt_version ~ '^[a-z0-9._-]{1,40}$'),
  CONSTRAINT mail_classification_calls_counts_are_not_negative
    CHECK (input_tokens >= 0 AND cached_input_tokens >= 0 AND output_tokens >= 0 AND latency_ms >= 0),
  -- An attempt that sent nothing spent nothing.
  CONSTRAINT mail_classification_calls_unsent_spent_nothing
    CHECK (request_sent
           OR (input_tokens = 0 AND cached_input_tokens = 0 AND output_tokens = 0 AND latency_ms = 0)),
  CONSTRAINT mail_classification_calls_unsent_outcome
    CHECK (request_sent = (outcome NOT IN ('disabled', 'capped', 'not_applicable'))),
  CONSTRAINT mail_classification_calls_refusal_category_is_a_refusal
    CHECK (refusal_category IS NULL OR outcome = 'refusal')
);

CREATE INDEX mail_classification_calls_by_date
  ON mail_classification_calls (workspace_id, business_date, called_at);

-- ---------------------------------------------------------------------------
-- mail_reply_confirmations (specification 8.3, 7.3, Appendix A "Confirm disposition")
--
-- "The salesperson normally confirms or corrects the preselected disposition in one
-- click. Consequential actions — closing an opportunity, committing a callback date
-- extracted from prose, creating a suppression from ambiguous wording, or releasing
-- automation — require deterministic proof or confirmation."
--
-- This table is the confirmation. `confirmed_by_user_id` is NOT NULL and references
-- a membership, so a row cannot be written by the worker, by a job, or on the
-- model's say-so: 12.4's boundary is a foreign key rather than a rule in a file.
--
-- `suggested_disposition` is what was on the card when the person answered, and
-- `corrected` is whether they changed it — kept in agreement by a CHECK, because a
-- correction that recorded itself as a confirmation would make 12.4's "a corrected
-- classification is audited" unauditable.
--
-- One confirmation per message. A second is refused as `already_confirmed` rather
-- than overwriting the first, the same shape `resolveAmbiguity` uses: a decision
-- that had consequences is not something a later click may quietly replace.
--
-- `consequences` names only what this command actually did. Closing an opportunity
-- is deliberately absent: 9.1's "Not interested — set manual and suggest Lost;
-- salesperson confirms closure" makes the close a separate explicit stage command,
-- and a disposition that closed a deal in one click would be exactly the
-- consequential action 8.3 is protecting.
-- ---------------------------------------------------------------------------
CREATE TABLE mail_reply_confirmations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  mail_message_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  disposition text NOT NULL,
  suggested_disposition text,
  suggested_by text NOT NULL,
  corrected boolean NOT NULL,
  confirmed_by_user_id uuid NOT NULL,
  consequences text[] NOT NULL DEFAULT '{}'::text[],
  callback_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_reply_confirmations_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT mail_reply_confirmations_message_fkey FOREIGN KEY (workspace_id, mail_message_id)
    REFERENCES mail_messages (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mail_reply_confirmations_opportunity_fkey FOREIGN KEY (workspace_id, opportunity_id, firm_id)
    REFERENCES opportunities (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT mail_reply_confirmations_callback_fkey FOREIGN KEY (workspace_id, callback_id)
    REFERENCES callbacks (workspace_id, id),
  -- The boundary, as a foreign key: a confirmation belongs to a member of this
  -- workspace. The worker's actor is `system` and has no row here.
  CONSTRAINT mail_reply_confirmations_confirmer_fkey FOREIGN KEY (workspace_id, confirmed_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT mail_reply_confirmations_one_per_message UNIQUE (workspace_id, mail_message_id),
  CONSTRAINT mail_reply_confirmations_disposition_known
    CHECK (disposition IN ('interested', 'referral_or_wrong_person', 'follow_up_later',
                           'not_interested', 'opt_out', 'other')),
  CONSTRAINT mail_reply_confirmations_suggested_disposition_known
    CHECK (suggested_disposition IS NULL
           OR suggested_disposition IN ('interested', 'referral_or_wrong_person', 'follow_up_later',
                                        'not_interested', 'opt_out', 'other')),
  CONSTRAINT mail_reply_confirmations_suggested_by_known
    CHECK (suggested_by IN ('deterministic', 'model', 'none')),
  CONSTRAINT mail_reply_confirmations_corrected_agrees
    CHECK (corrected = (suggested_disposition IS DISTINCT FROM disposition)),
  CONSTRAINT mail_reply_confirmations_consequences_known
    CHECK (consequences <@ ARRAY['opportunity_manual', 'callback_committed', 'handle_suppressed',
                                 'firm_suppressed', 'holds_released', 'today_item_completed']::text[]),
  -- A callback id is recorded exactly when committing one was a consequence, and
  -- committing one is only ever a consequence of a person saying so (12.4).
  CONSTRAINT mail_reply_confirmations_callback_is_a_consequence
    CHECK ((callback_id IS NOT NULL) = ('callback_committed' = ANY (consequences))),
  CONSTRAINT mail_reply_confirmations_note_bounded
    CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 2000))
);

CREATE INDEX mail_reply_confirmations_by_opportunity
  ON mail_reply_confirmations (workspace_id, opportunity_id, created_at);

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so each table here needs its own grant.
--
-- `mail_classification_calls` and `mail_reply_confirmations` are append-only: an
-- attempt and a person's decision are both records of something that happened.
-- DELETE stays on both, because 10.3's documented deletion workflow has to be able
-- to remove a firm's correspondence and everything that hangs off it.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON classifier_settings TO app_runtime, migration;

GRANT SELECT, INSERT, DELETE ON mail_classification_calls TO app_runtime, migration;
REVOKE UPDATE, TRUNCATE ON mail_classification_calls FROM app_runtime, migration;

GRANT SELECT, INSERT, DELETE ON mail_reply_confirmations TO app_runtime, migration;
REVOKE UPDATE, TRUNCATE ON mail_reply_confirmations FROM app_runtime, migration;
