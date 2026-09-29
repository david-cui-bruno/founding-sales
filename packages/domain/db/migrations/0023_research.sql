-- ---------------------------------------------------------------------------
-- 0023_research.sql — research with evidence (lane R)
--
-- The research feature was deleted on 26 September 2026 (commit 59b3e1bb) and
-- migration 0019 dropped its eight tables. This is the smaller thing that replaces
-- it: read the firm's own website, record what it published as evidence, keep four
-- judgments apart, and price every model call in cents before it is made
-- (`.context/DECISION-20260928-crm-design.md`, "Research"; David's answers 5 and 8).
--
-- ## Additive only, and it refuses on nothing
--
-- Every object below is new. No table is dropped, no column is removed, no CHECK is
-- narrowed and no row is rewritten, so there is nothing this file can refuse on and
-- there is **no `fss admin schema-preflight` command for it** — the release skips
-- step 3. The one statement that is not a creation is the `CREATE OR REPLACE` of
-- `today_algorithm_version()` at the bottom, which replaces a two-line SQL function
-- with a two-line SQL function and reads no rows.
--
-- It is still a schema release: `packages/domain/db/schemaRange.ts` moves both ranges
-- together (to {23, 23}), as every release since 0006 has, so an image only ever meets its own
-- schema.
--
-- ## Five things run through the file
--
--   * **Every fact points at the evidence that carries it.** `firm_facts.evidence_id`
--     is a foreign key onto `evidence_items` — the row 0004 already had, whose
--     uniqueness is `(workspace, firm, contact, provider, content hash)`. A quote with
--     no evidence row cannot be inserted, which is what makes "every fact shows its
--     source and its retrieval date" a property of the schema rather than of a report.
--   * **The four judgments are one row, replaced whole.** `firm_judgments` is keyed by
--     the firm, not by the run: what a person reads is the current judgment, and the
--     history of how it got there is the run rows and the facts they recorded. Each of
--     the four is `yes | no | unknown`, and `unknown` is the honest third state — none
--     of them may be inferred to `no` from silence.
--   * **Nothing here can hold a budget or an intent.** There is no column for either,
--     deliberately. "A portal link can support a software inference; a maintenance job
--     posting can suggest an opportunity for discussion. Neither proves budget or
--     buying intent."
--   * **The money is counted before it is spent.** `research_settings` carries three
--     ceilings in whole cents and `provider_ledger` carries what was actually spent
--     per provider per workspace business date. The count ceiling is `daily_counters`
--     (0001) through `incrementDailyCounter`, which is one statement; this table is the
--     accounting, which is only knowable afterwards. See `research/ceilings.ts`.
--   * **A missing settings row means the defaults.** There is no seed and no trigger.
--     A workspace that has never configured research researches at the column defaults
--     below, which is the opposite of the 0007 table it replaces — that one seeded
--     `enabled = false`, and the result was a feature nobody ever turned on. The
--     ceilings are what makes an enabled default safe.
--
-- ## Invoices live in provider_ledger; authorizations live in provider_reservations
--
-- `provider_ledger.cost_cents` is what was invoiced, aggregated per provider per
-- business date. What has been *authorized and not yet invoiced* is one row per attempt
-- in `provider_reservations`, and the difference between a column and a row is the whole
-- point: an aggregate counter can be incremented by one run and decremented by another,
-- and a run reserved yesterday settling against today's total is a silent loss of
-- somebody else's cents. A row has an identity, a date of its own, and a state — so a
-- call can be settled exactly once, by id, on the date it was authorized on.
--
-- ## provider_ledger is generic on purpose
--
-- Not `research_provider_ledger`. The telephony lane (C) and the calendar lane (D)
-- each need "what did this provider cost today, and what failed", and three tables
-- with the same five columns would be three places to get the business date wrong.
-- The key is `(workspace, provider_key, business_date)` and the zone that produced the
-- date is stored beside it, exactly as `daily_counters` does, so changing the
-- workspace zone later cannot re-date yesterday's spend.
--
-- ## Merges
--
-- Every firm reference is `ON UPDATE CASCADE`, like 0004's children, so nothing here is
-- orphaned by a merge. What a merge *does* with each table is `crm/merges.ts`'s
-- decision and it is not the same for all four: the judgment is one current opinion and
-- cannot be added to another firm's, the links are decisions about the surviving firm
-- and are copied, and the runs and the facts stay on the merged record because a page
-- read for one firm is not provenance for another. `firm_judgments.likely_contact_id`
-- carries the semantic triple, so the judgment has to be dealt with *before* the
-- contacts move or the cascade lands it on the target's primary key.
--
-- Seeded rows carry a named constant instant rather than now(); this migration seeds
-- none.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- research_settings — one row per workspace, and an absent row is the defaults
--
-- `model_name` admits exactly one value, and that is not an oversight. A model is
-- allowed to run only when `pricing.ts` has a reviewed price row for it, and a price
-- row is a number somebody read off a price list on a date. Admitting a second model
-- here without adding its price would let a run be authorized against a worst case
-- computed from the wrong numbers, which is the one way a cents ceiling can be
-- quietly wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE research_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  enabled boolean NOT NULL DEFAULT true,
  daily_firm_ceiling integer NOT NULL DEFAULT 50,
  daily_cost_ceiling_cents integer NOT NULL DEFAULT 50,
  monthly_cost_ceiling_cents integer NOT NULL DEFAULT 1000,
  max_pages_per_firm integer NOT NULL DEFAULT 4,
  max_page_bytes integer NOT NULL DEFAULT 1000000,
  model_name text NOT NULL DEFAULT 'claude-haiku-4-5',
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_settings_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT research_settings_editor_fkey FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT research_settings_firm_ceiling_range CHECK (daily_firm_ceiling BETWEEN 0 AND 10000),
  CONSTRAINT research_settings_daily_cost_nonnegative CHECK (daily_cost_ceiling_cents >= 0),
  CONSTRAINT research_settings_monthly_cost_nonnegative CHECK (monthly_cost_ceiling_cents >= 0),
  CONSTRAINT research_settings_pages_per_firm_range CHECK (max_pages_per_firm BETWEEN 1 AND 8),
  CONSTRAINT research_settings_page_bytes_range CHECK (max_page_bytes BETWEEN 1024 AND 1000000),
  CONSTRAINT research_settings_model_known CHECK (model_name IN ('claude-haiku-4-5')),
  CONSTRAINT research_settings_updated_not_before_created CHECK (updated_at >= created_at)
);

-- ---------------------------------------------------------------------------
-- research_runs — one run of one firm at one revision
--
-- `UNIQUE (workspace, firm, revision)` is the handler's declared `business_uniqueness`:
-- a `research.firm` job claimed twice finds the row it already opened and records
-- nothing a second time.
--
-- The run row is written in **three committed steps**, because the middle of it spends
-- money:
--
--   1. open the row, consume the day's count, insert `provider_reservations` attempt 1
--      in state `reserved`. Nothing has been called;
--   2. mark that reservation `calling` and commit *nothing else*. This step exists only
--      to make "a call may now have happened" durable;
--   3. fetch, extract, record, settle the reservation by its id, and close the row.
--
-- `outcome = 'running'` between them is therefore a normal state and not a crash — but a
-- row still `running` half an hour later is one, and the sweep finalises it `failed`
-- with `refusal_code = 'lease_lost'`, writing the sum of that run's reservations into
-- `cost_cents`. `cost_estimated` says the figure is a reservation rather than an
-- invoice: a transport that threw, a response with no usage, and a lost lease all record
-- what was reserved rather than zero, because zero is the one answer that is certainly
-- wrong about a call that may have been billed.
--
-- `brief` holds the **generated** parts only — the two questions and the opening line
-- a model wrote. Everything else on the call brief is assembled from quotes and
-- judgments at read time, so the one part of the brief that is not the firm's own
-- words is the one part stored under a column called `brief`, and the desktop labels
-- it an AI suggestion. `generated: true` inside the object is the same claim, carried
-- with the value.
-- ---------------------------------------------------------------------------
CREATE TABLE research_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  revision integer NOT NULL,
  trigger text NOT NULL,
  requested_by_user_id uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  outcome text NOT NULL DEFAULT 'running',
  refusal_code text,
  pages_fetched integer NOT NULL DEFAULT 0,
  facts_recorded integer NOT NULL DEFAULT 0,
  model_name text,
  extraction text NOT NULL DEFAULT 'unconfigured',
  cost_estimated boolean NOT NULL DEFAULT false,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  brief jsonb,
  CONSTRAINT research_runs_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT research_runs_one_per_revision UNIQUE (workspace_id, firm_id, revision),
  CONSTRAINT research_runs_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT research_runs_requester_fkey FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT research_runs_revision_positive CHECK (revision >= 1),
  CONSTRAINT research_runs_trigger_known
    CHECK (trigger IN ('firm_created', 'sweep', 'user_request', 'link_added')),
  -- A person asked for it, or the system did. Both are recorded; neither is guessed.
  CONSTRAINT research_runs_requester_consistent
    CHECK ((trigger IN ('user_request', 'link_added')) = (requested_by_user_id IS NOT NULL)),
  CONSTRAINT research_runs_outcome_known CHECK (outcome IN ('running', 'completed', 'refused', 'failed')),
  CONSTRAINT research_runs_completion_consistent CHECK ((outcome = 'running') = (completed_at IS NULL)),
  CONSTRAINT research_runs_refusal_consistent
    CHECK ((outcome IN ('refused', 'failed')) = (refusal_code IS NOT NULL)),
  CONSTRAINT research_runs_refusal_code_shape
    CHECK (refusal_code IS NULL OR refusal_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT research_runs_pages_nonnegative CHECK (pages_fetched >= 0),
  CONSTRAINT research_runs_facts_nonnegative CHECK (facts_recorded >= 0),
  CONSTRAINT research_runs_model_name_shape
    CHECK (model_name IS NULL OR model_name ~ '^[a-z][a-z0-9.-]{1,63}$'),
  -- Why the model was or was not used, which `model_name IS NULL` could not say.
  -- `unconfigured` is the only one the sweep re-selects: a run that read no pages will
  -- read no pages tomorrow either, and re-selecting it was an unbounded daily spend on
  -- a firm with nothing to read. `over_budget` is the exact token count refusing a
  -- request the reservation would not cover — a decision made *before* the call, so it
  -- costs nothing and is not a failure.
  CONSTRAINT research_runs_extraction_known
    CHECK (extraction IN ('used', 'unconfigured', 'no_pages', 'failed', 'over_budget')),
  CONSTRAINT research_runs_extraction_consistent
    CHECK ((extraction = 'used') = (model_name IS NOT NULL)),
  CONSTRAINT research_runs_input_tokens_nonnegative CHECK (input_tokens >= 0),
  CONSTRAINT research_runs_output_tokens_nonnegative CHECK (output_tokens >= 0),
  CONSTRAINT research_runs_cost_nonnegative CHECK (cost_cents >= 0),
  CONSTRAINT research_runs_brief_is_bounded_object
    CHECK (brief IS NULL OR (jsonb_typeof(brief) = 'object' AND length(brief::text) <= 4000))
);

CREATE INDEX research_runs_by_firm ON research_runs (workspace_id, firm_id, revision DESC);
-- `openRun` asks whether this firm has a run still `running` and younger than half an
-- hour. A partial index on exactly those rows.
CREATE INDEX research_runs_in_progress ON research_runs (workspace_id, firm_id, started_at DESC)
  WHERE outcome = 'running';

-- ---------------------------------------------------------------------------
-- firm_facts — a quote, the evidence it came from, and the block inside it
--
-- One row is one selection a run admitted: a key from the closed set in `facts.ts`,
-- the evidence item that recorded the page, the block id inside that page, and the
-- block's whole text as the quote. The provider never supplies the quote — it returns
-- a block reference and `validateFactSelections` looks the text up — so a paraphrase,
-- a trimmed qualifier or a dropped negation cannot reach this table.
--
-- Uniqueness is `(workspace, firm, key, evidence, block)`: the same sentence selected
-- for the same key twice is one row, and the same sentence selected for two different
-- keys is two, which is correct — one block can say two things.
--
-- ## `first_party` — whose words these are
--
-- True for the firm's own site (an allow-listed path, or a page its own homepage linked
-- to). False for a link a person added on somebody else's host. The column exists
-- because the call brief presents a quote as what the firm said, and a page on another
-- host is not the firm saying anything: `judgments.ts` will not let a third-party block
-- decide `fit`, and `brief.ts` renders one with its host attached. Without the column
-- the read side cannot tell the two apart, and "the firm's own words" would quietly
-- become "a sentence from a page somebody pasted".
--
-- ## The person keys store no quote
--
-- `named_role`, `phone_listed` and `role` are selected *because* a block names a person
-- or publishes a number — that is the whole point of them — so the block's text is
-- exactly the text a person's deletion is supposed to remove. A contact-scoped deletion
-- does not touch firm rows, so a quote kept here would outlive the contact it names.
--
-- So for those three keys the quote is NULL and the evidence id and block id stay: the
-- reachability judgment needs to know a page said so, and it does not need the sentence
-- to be repeated in a second table. `firm_facts_person_keys_have_no_quote` is an
-- equality rather than an implication, so a key in that set cannot acquire a quote and
-- a key outside it cannot lose one.
-- ---------------------------------------------------------------------------
CREATE TABLE firm_facts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  run_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  key text NOT NULL,
  block_id text NOT NULL,
  quote text,
  first_party boolean NOT NULL DEFAULT true,
  confidence numeric(4, 3),
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_facts_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT firm_facts_one_per_selection UNIQUE (workspace_id, firm_id, key, evidence_id, block_id),
  CONSTRAINT firm_facts_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT firm_facts_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT firm_facts_evidence_fkey FOREIGN KEY (workspace_id, evidence_id)
    REFERENCES evidence_items (workspace_id, id),
  CONSTRAINT firm_facts_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT firm_facts_block_id_bounded CHECK (btrim(block_id) <> '' AND length(block_id) <= 64),
  CONSTRAINT firm_facts_quote_present
    CHECK (quote IS NULL OR (btrim(quote) <> '' AND length(quote) <= 500)),
  CONSTRAINT firm_facts_person_keys_have_no_quote
    CHECK ((quote IS NULL) = (key IN ('named_role', 'phone_listed', 'role'))),
  CONSTRAINT firm_facts_confidence_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX firm_facts_by_firm ON firm_facts (workspace_id, firm_id, retrieved_at DESC);

-- ---------------------------------------------------------------------------
-- firm_judgments — the four, kept apart, and replaced by each completed run
--
-- The primary key is the firm, so there is exactly one current judgment and reading
-- it is a point lookup. `reasons` is one short sentence per judgment naming the fact
-- ids it rests on, so "why does this say yes" is answerable without re-deriving it.
--
-- `call_first` is not a fifth judgment; it is the queue's question, computed from two
-- of the four (`fit = yes` and `reachability <> no`) and stored because the Today
-- lane orders on it.
-- ---------------------------------------------------------------------------
CREATE TABLE firm_judgments (
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  run_id uuid NOT NULL,
  fit text NOT NULL,
  problem_evidence text NOT NULL,
  timing text NOT NULL,
  reachability text NOT NULL,
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  call_first boolean NOT NULL DEFAULT false,
  likely_contact_id uuid,
  judged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_judgments_pkey PRIMARY KEY (workspace_id, firm_id),
  CONSTRAINT firm_judgments_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT firm_judgments_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES research_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT firm_judgments_contact_fkey FOREIGN KEY (workspace_id, likely_contact_id, firm_id)
    REFERENCES contacts (workspace_id, id, firm_id) ON UPDATE CASCADE,
  CONSTRAINT firm_judgments_fit_known CHECK (fit IN ('yes', 'no', 'unknown')),
  CONSTRAINT firm_judgments_problem_known CHECK (problem_evidence IN ('yes', 'no', 'unknown')),
  CONSTRAINT firm_judgments_timing_known CHECK (timing IN ('yes', 'no', 'unknown')),
  CONSTRAINT firm_judgments_reachability_known CHECK (reachability IN ('yes', 'no', 'unknown')),
  CONSTRAINT firm_judgments_reasons_is_object CHECK (jsonb_typeof(reasons) = 'object'),
  -- One short reason per judgment. Bounded here so a model-written sentence cannot
  -- grow into a paragraph nobody reads.
  CONSTRAINT firm_judgments_reasons_bounded CHECK (length(reasons::text) <= 1600),
  -- The queue's rule, as a CHECK: a firm cannot be queued for a call it is not a fit
  -- for, and cannot be queued when it cannot be reached.
  CONSTRAINT firm_judgments_call_first_consistent
    CHECK (call_first = (fit = 'yes' AND reachability <> 'no'))
);

CREATE INDEX firm_judgments_call_first ON firm_judgments (workspace_id, firm_id) WHERE call_first;

-- ---------------------------------------------------------------------------
-- firm_links — the pages David adds by hand
--
-- The one way a URL that is not on the firm's own host becomes readable. A link is
-- always somebody's decision: `added_by_user_id` is NOT NULL, so there is no path by
-- which research widens its own reach.
-- ---------------------------------------------------------------------------
CREATE TABLE firm_links (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  url text NOT NULL,
  added_by_user_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_links_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT firm_links_one_per_url UNIQUE (workspace_id, firm_id, url),
  CONSTRAINT firm_links_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id) ON UPDATE CASCADE,
  CONSTRAINT firm_links_author_fkey FOREIGN KEY (workspace_id, added_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  -- https only, and bounded. PostgreSQL caps a bounded repetition at 255, so the
  -- length is a separate term, as `firms_website_shape` does.
  CONSTRAINT firm_links_url_shape
    CHECK (url ~ '^https://[^[:space:]]{3,}$' AND length(url) <= 500)
);

CREATE INDEX firm_links_by_firm ON firm_links (workspace_id, firm_id, added_at DESC);

-- ---------------------------------------------------------------------------
-- provider_ledger — what a paid provider cost, per workspace business date
--
-- Generic, so lane C (Twilio) and lane D reuse it rather than adding a third table
-- with the same five columns. `provider_key` takes the same shape
-- `evidence_items.provider` does, so a ledger row and the evidence it paid for name
-- the provider identically.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_ledger (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  provider_key text NOT NULL,
  business_date date NOT NULL,
  business_time_zone text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  last_failure_code text,
  last_failure_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_ledger_pkey PRIMARY KEY (workspace_id, provider_key, business_date),
  CONSTRAINT provider_ledger_provider_key_shape CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  CONSTRAINT provider_ledger_calls_nonnegative CHECK (calls >= 0),
  CONSTRAINT provider_ledger_failures_nonnegative CHECK (failures >= 0),
  CONSTRAINT provider_ledger_failures_within_calls CHECK (failures <= calls),
  CONSTRAINT provider_ledger_cost_nonnegative CHECK (cost_cents >= 0),
  CONSTRAINT provider_ledger_failure_code_shape
    CHECK (last_failure_code IS NULL OR last_failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT provider_ledger_failure_recorded
    CHECK ((last_failure_code IS NULL) = (last_failure_at IS NULL)),
  CONSTRAINT provider_ledger_business_time_zone_shape
    CHECK (business_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$')
);

-- ---------------------------------------------------------------------------
-- The Today algorithm version
--
-- Lane 4's order changed: a researched firm whose judgment says call it first goes
-- ahead of the rest, and each group stays oldest first. Appendix C makes the algorithm
-- version part of the Today job's identity, so changing the ordering means changing
-- this string — otherwise this morning's rebuild would be a second attempt at
-- yesterday's job rather than a different one. `TODAY_ALGORITHM_VERSION` in
-- `packages/domain/today/types.ts` is the other side and a test compares them.
--
-- The function cannot move without a statement, so the statement is here: `CREATE OR
-- REPLACE` of a two-line IMMUTABLE SQL function. It is the default of
-- `today_snapshots.algorithm_version`, so rows written from now on carry `today.2` and
-- rows already written keep the string they were built under, which is the record of
-- what that day's list actually was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION today_algorithm_version() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'today.2'::text $$;

-- ---------------------------------------------------------------------------
-- provider_reservations — one row per paid attempt, from authorized to settled
--
-- A paid provider call cannot be inside the transaction that records it: the call is
-- out in the world before the commit, so a rollback loses the record and keeps the
-- invoice. This table is how that is survived, and it is deliberately generic — the
-- telephony lane's calls and the demo product's model calls need exactly the same
-- thing, which is why `subject_kind` exists at all with one value in it today.
--
-- ## The state machine
--
--   reserved  — cents authorized, nothing called yet. A crash here costs nothing: no
--               call can have happened, so the row is `released`.
--   calling   — committed *before* the call. This is the marker that says "a call may
--               now have happened", and it is the reason a retry cannot quietly make a
--               second one for free: a reservation found still `calling` means the
--               previous attempt is ambiguous.
--   settled   — the provider reported a figure. `settled_cents` is that figure.
--   estimated — nobody reported one: the transport threw, the response carried no
--               usage, or the worker vanished after `calling`. `settled_cents` is the
--               reservation, because zero is the one answer certainly wrong about a
--               call that may have been billed.
--   released  — no call happened and none can have. `settled_cents` is zero.
--
-- ## Why the attempt is in the key
--
-- `UNIQUE (workspace, subject_kind, subject_id, attempt)` makes a retry's reservation a
-- *different row* from the attempt it is retrying. Reusing one row would mean either
-- settling it twice or calling twice against one authorization, and the handler's
-- `maxAttempts` then bounds the number of rows — three reservations at three cents is
-- the worst a firm can cost in a day, and that is a number a person can check.
--
-- ## Dates
--
-- `business_date` and `business_time_zone` are the reservation's own, copied at
-- insertion exactly as `daily_counters` does. A run authorized yesterday and settled
-- today adds its invoice to *yesterday's* ledger row, because that is the day whose
-- budget it was cleared against.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_reservations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  provider_key text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  attempt integer NOT NULL,
  business_date date NOT NULL,
  business_time_zone text NOT NULL,
  cents integer NOT NULL,
  state text NOT NULL DEFAULT 'reserved',
  settled_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT provider_reservations_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT provider_reservations_one_per_attempt
    UNIQUE (workspace_id, subject_kind, subject_id, attempt),
  CONSTRAINT provider_reservations_provider_key_shape
    CHECK (provider_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  -- One value today. The column exists so the next paid lane adds a value rather than
  -- a table, and the CHECK is what makes adding one a deliberate edit.
  CONSTRAINT provider_reservations_subject_known CHECK (subject_kind IN ('research_run')),
  CONSTRAINT provider_reservations_attempt_positive CHECK (attempt >= 1),
  CONSTRAINT provider_reservations_cents_nonnegative CHECK (cents >= 0),
  CONSTRAINT provider_reservations_settled_nonnegative CHECK (settled_cents >= 0),
  CONSTRAINT provider_reservations_state_known
    CHECK (state IN ('reserved', 'calling', 'settled', 'estimated', 'released')),
  -- An open reservation has settled nothing and is not dated as settled; a closed one
  -- is. The pair is what makes `readSpend`'s "reserved or calling" filter total.
  CONSTRAINT provider_reservations_settlement_consistent
    CHECK ((state IN ('reserved', 'calling')) = (settled_at IS NULL)),
  CONSTRAINT provider_reservations_open_settles_nothing
    CHECK (state NOT IN ('reserved', 'calling') OR settled_cents = 0),
  -- A released reservation is the claim that no call happened, so it cannot carry cents.
  CONSTRAINT provider_reservations_released_is_free
    CHECK (state <> 'released' OR settled_cents = 0),
  CONSTRAINT provider_reservations_business_time_zone_shape
    CHECK (business_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){1,2}$')
);

-- `readSpend` sums the open reservations of one business date; the handler reads one
-- subject's rows newest first to recover its own step after a lost cursor.
CREATE INDEX provider_reservations_open_by_date
  ON provider_reservations (workspace_id, business_date, provider_key)
  WHERE state IN ('reserved', 'calling');
CREATE INDEX provider_reservations_by_subject
  ON provider_reservations (workspace_id, subject_kind, subject_id, attempt DESC);

-- ---------------------------------------------------------------------------
-- today_refresh_card — 0018's body, stamping the version it rebuilt under
--
-- `today_snapshots.algorithm_version` defaults to `today_algorithm_version()`, and a
-- default applies to an INSERT. A card that already existed when this release landed
-- is refreshed by the `ON CONFLICT DO UPDATE` branch below, which never touched the
-- column — so a card built yesterday under `today.1` and recomputed this morning under
-- `today.2` went on saying `today.1` for ever.
--
-- That matters because the read side asks. Lane 4's new order is applied only to a
-- snapshot that says it was built under `today.2`, so that a day's list recorded under
-- the old algorithm is still the list that day actually showed. A version that does not
-- move when the card does would make that check answer about the wrong algorithm.
--
-- Replaced rather than patched: a plpgsql function has no ALTER for one line of its
-- body. Everything else is byte for byte 0018's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION today_refresh_card(p_workspace_id uuid, p_snapshot_date date, p_firm_id uuid)
RETURNS void LANGUAGE plpgsql AS $today$
DECLARE
  v_lane text;
  v_sort timestamptz;
  v_open integer;
  v_replies integer;
  v_emails integer;
  v_calls integer;
  v_assignee uuid;
BEGIN
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE kind = 'reply'))::integer,
         (count(*) FILTER (WHERE kind = 'email_due'))::integer,
         (count(*) FILTER (WHERE kind = 'call_due'))::integer
    INTO v_open, v_replies, v_emails, v_calls
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open';

  -- `item_key` is the last tiebreak rather than `id`, so two databases holding the
  -- same tasks choose the same one: a generated uuid is not the same in both.
  SELECT lane, due_at
    INTO v_lane, v_sort
    FROM today_items
   WHERE workspace_id = p_workspace_id
     AND snapshot_date = p_snapshot_date
     AND firm_id = p_firm_id
     AND status = 'open'
   ORDER BY today_lane_precedence(lane), due_at, item_key
   LIMIT 1;

  SELECT assigned_user_id INTO v_assignee
    FROM firms WHERE workspace_id = p_workspace_id AND id = p_firm_id;

  -- Nothing unfinished and no card: there is nothing to say. A card is never created
  -- empty, so the list never shows a firm with no work on it.
  IF v_lane IS NULL AND NOT EXISTS (
    SELECT 1 FROM today_snapshots
     WHERE workspace_id = p_workspace_id AND snapshot_date = p_snapshot_date AND firm_id = p_firm_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO today_snapshots
    (workspace_id, snapshot_date, firm_id, lane, sort_at, assigned_user_id,
     open_items, replies_due, emails_due, calls_due)
  VALUES
    (p_workspace_id, p_snapshot_date, p_firm_id, COALESCE(v_lane, 'new_firm'),
     COALESCE(v_sort, now()), v_assignee, v_open, v_replies, v_emails, v_calls)
  ON CONFLICT ON CONSTRAINT today_snapshots_pkey DO UPDATE
     SET lane = COALESCE(v_lane, today_snapshots.lane),
         sort_at = COALESCE(v_sort, today_snapshots.sort_at),
         assigned_user_id = v_assignee,
         open_items = v_open,
         replies_due = v_replies,
         emails_due = v_emails,
         calls_due = v_calls,
         -- The one line that is not 0018's. A card recomputed now is a card ordered by
         -- the algorithm running now, and a row that went on claiming `today.1` after
         -- being rebuilt under `today.2` would make the read side's version check a
         -- lie about the row it is looking at.
         algorithm_version = today_algorithm_version(),
         updated_at = greatest(now(), today_snapshots.built_at);
END
$today$;

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so every new table names its grants (0004 says the same).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON research_settings TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_runs TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON firm_facts TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON firm_judgments TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON firm_links TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_ledger TO app_runtime, migration;
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_reservations TO app_runtime, migration;
