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
-- ## provider_ledger is generic on purpose
--
-- Not `research_provider_ledger`. The telephony lane (C) and the calendar lane (D)
-- each need "what did this provider cost today, and what failed", and three tables
-- with the same five columns would be three places to get the business date wrong.
-- The key is `(workspace, provider_key, business_date)` and the zone that produced the
-- date is stored beside it, exactly as `daily_counters` does, so changing the
-- workspace zone later cannot re-date yesterday's spend.
--
-- ## Merges carry the rows
--
-- Every firm reference is `ON UPDATE CASCADE` on the firm triple, like 0004's children:
-- a merge moves a firm's rows to the surviving firm rather than orphaning them.
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
-- ---------------------------------------------------------------------------
CREATE TABLE firm_facts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  run_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  key text NOT NULL,
  block_id text NOT NULL,
  quote text NOT NULL,
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
  CONSTRAINT firm_facts_quote_present CHECK (btrim(quote) <> '' AND length(quote) <= 500),
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
