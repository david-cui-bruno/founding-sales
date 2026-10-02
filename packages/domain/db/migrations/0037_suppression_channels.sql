-- ---------------------------------------------------------------------------
-- 0037_suppression_channels.sql — a stop says which channel it stops (slice S3X, Part 1)
-- changes: suppression_events, effective_suppressions
--
-- David, 2 October 2026 (P1, P2): "Do not call" stops phone calls only; an explicit
-- "don't contact me again" stops both channels; an e-mail opt-out stops e-mail only.
-- Every stop existing before this file means all channels. Scope (handle or firm) and
-- channel are independent: firm × {phone, email, all} as well as handle × the same.
--
-- ## What `-- changes:` names, and why
--
--   * `suppression_events` — gains `channel text NOT NULL DEFAULT 'all'`. On PostgreSQL
--     11 and later a constant default is metadata only: no table rewrite, and no UPDATE
--     privilege is needed (both roles have UPDATE revoked on this table, 0001). Every
--     stored row reads `all`, which is what P2 says it means. Two CHECKs:
--       - `suppression_events_channel_known`: `phone`, `email` or `all`;
--       - `suppression_events_channel_fits_key`: a handle stop on a phone number cannot
--         be `email`, and one on an address cannot be `phone` — such a stop is one no
--         reader would ever read. Every stored row is `all`, which passes.
--     `assert_supersession_same_key()` (0006) also requires a supersession to name the
--     channel of the event it supersedes. The trigger and its name are unchanged.
--   * `effective_suppressions` — one row per (workspace, scope, canonical key, channel)
--     instead of per key, with `channel` appended as the last column (CREATE OR REPLACE
--     keeps the earlier columns in order and the grants of 0006). A key holding a `phone`
--     event and an `email` event shows both, so an e-mail reader filtering by channel
--     never misses the `email` one behind the earlier `phone` one.
--
-- ## Older binaries
--
-- An older binary reading the view ignores `channel` and treats every row as a stop of
-- everything; one inserting a row gets the default `all`. Both are the conservative
-- direction.
--
-- ## Release shape
--
-- `touches-existing` (ALTER TABLE on an existing table, a replaced function and view).
-- ---------------------------------------------------------------------------

ALTER TABLE suppression_events ADD COLUMN channel text NOT NULL DEFAULT 'all';

ALTER TABLE suppression_events
  ADD CONSTRAINT suppression_events_channel_known
    CHECK (channel IN ('phone', 'email', 'all'));

ALTER TABLE suppression_events
  ADD CONSTRAINT suppression_events_channel_fits_key
    CHECK (scope = 'firm'
           OR channel = 'all'
           OR (channel = 'email') = (position('@' in canonical_key) > 0));

-- 0006's function, with the channel added to the comparison. A narrower or wider lift is
-- a supersession of the event followed by a new event, never a supersession that changes
-- what it lifts.
CREATE OR REPLACE FUNCTION assert_supersession_same_key() RETURNS trigger
LANGUAGE plpgsql AS $supersession$
DECLARE
  original suppression_events%ROWTYPE;
BEGIN
  IF NEW.supersedes_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO original
    FROM suppression_events
   WHERE workspace_id = NEW.workspace_id AND event_id = NEW.supersedes_event_id;
  IF NOT FOUND THEN
    -- The composite foreign key reports this one; nothing to add.
    RETURN NEW;
  END IF;
  IF original.scope <> NEW.scope
     OR original.canonical_key <> NEW.canonical_key
     OR original.channel <> NEW.channel THEN
    RAISE EXCEPTION
      'a supersession names the same scope, canonical key and channel as the event it supersedes'
      USING ERRCODE = 'integrity_constraint_violation',
            CONSTRAINT = 'suppression_events_supersession_same_key';
  END IF;
  RETURN NEW;
END
$supersession$;

-- One row per (workspace, scope, canonical key, channel), carrying the earliest effective
-- event of that channel. A reader filters `channel IN (<its channel>, 'all')`.
CREATE OR REPLACE VIEW effective_suppressions AS
SELECT DISTINCT ON (e.workspace_id, e.scope, e.canonical_key, e.channel)
       e.workspace_id,
       e.scope,
       e.canonical_key,
       e.event_id,
       e.canonicalizer_version,
       e.source,
       e.actor_user_id,
       e.recorded_at,
       e.channel
  FROM suppression_events e
 WHERE e.supersedes_event_id IS NULL
   AND NOT EXISTS (
     SELECT 1
       FROM suppression_events s
      WHERE s.workspace_id = e.workspace_id
        AND s.supersedes_event_id = e.event_id
   )
 ORDER BY e.workspace_id, e.scope, e.canonical_key, e.channel, e.recorded_at, e.event_id;
