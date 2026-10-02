-- ---------------------------------------------------------------------------
-- 0038_firm_prepared_briefs.sql — a firm's prepared brief and its sources (lane PB)
-- changes: (none; one new table and one new function)
--
-- David, 2 October 2026: the DFW call briefs and their source evidence were prepared
-- outside Callie (a research agent on the web, phones verified by hand). Callie's own
-- research brief (`firm_facts`, `firm_judgments`, 0023) holds only the firm's own quoted
-- words, extracted by a model; it is not a place for somebody's prepared text. So the
-- prepared brief is a row of its own, shown beside the research brief and labelled as
-- prepared research that Callie has not verified.
--
-- ## The new table
--
--   * `firm_prepared_briefs` — one row per (workspace, firm).
--       - `brief` — the prepared text, 1–4000 characters, not blank.
--       - `sources` — a JSON array of at most 30 `{url, label}` objects and nothing else:
--         an https URL of at most 500 characters (the shape `firm_links_url_shape` uses)
--         and a label of 1–200 characters. `prepared_brief_sources_valid` checks it; a
--         CHECK cannot hold a subquery, so the walk over the elements is a function.
--       - `observed_on` — the day the research was done, as the preparer recorded it.
--       - `prepared_by` — who prepared it ("Callie research agent (web), verified
--         phones"), 1–200 characters.
--       - `updated_by_user_id` — the member whose command wrote the row last; null only
--         for a system actor.
--     Classified `deletion_removes`: a firm-scoped deletion removes it with the firm. A
--     merge keeps the surviving firm's own row, or moves the merged firm's when the
--     survivor has none (`crm/merges.ts`).
--
-- ## Release shape
--
-- `additive`: a new table and a new function no deployed binary references. An older
-- binary never reads the table; the firm page and Today read it only when a client
-- negotiates `include: ['preparedBrief']`.
-- ---------------------------------------------------------------------------

CREATE FUNCTION prepared_brief_sources_valid(sources jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $sources$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(sources) <> 'array' OR jsonb_array_length(sources) > 30 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(sources) LOOP
    IF jsonb_typeof(item) <> 'object' THEN
      RETURN false;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(item)) <> 2
       OR jsonb_typeof(item -> 'url') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item -> 'label') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    IF (item ->> 'url') !~ '^https://[^[:space:]]{3,}$'
       OR char_length(item ->> 'url') > 500
       OR btrim(item ->> 'label') = ''
       OR char_length(item ->> 'label') > 200 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END
$sources$;

CREATE TABLE firm_prepared_briefs (
  workspace_id uuid NOT NULL,
  firm_id uuid NOT NULL,
  brief text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_on date NOT NULL,
  prepared_by text NOT NULL,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firm_prepared_briefs_pkey PRIMARY KEY (workspace_id, firm_id),
  CONSTRAINT firm_prepared_briefs_firm_fkey FOREIGN KEY (workspace_id, firm_id)
    REFERENCES firms (workspace_id, id),
  CONSTRAINT firm_prepared_briefs_updater_fkey FOREIGN KEY (workspace_id, updated_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT firm_prepared_briefs_brief_bounded
    CHECK (btrim(brief) <> '' AND char_length(brief) <= 4000),
  CONSTRAINT firm_prepared_briefs_sources_shape CHECK (prepared_brief_sources_valid(sources)),
  CONSTRAINT firm_prepared_briefs_prepared_by_bounded
    CHECK (btrim(prepared_by) <> '' AND char_length(prepared_by) <= 200),
  CONSTRAINT firm_prepared_briefs_updated_not_before_created CHECK (updated_at >= created_at)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON firm_prepared_briefs TO app_runtime, migration;
