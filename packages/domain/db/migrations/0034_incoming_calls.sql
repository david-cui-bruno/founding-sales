-- ---------------------------------------------------------------------------
-- 0034_incoming_calls.sql — a call log says which way the call went (slice S2)
-- changes: call_logs
--
-- Callbacks ring David's mobile: the caller ID of every call placed from Callie is his own
-- verified number, and Callie has no incoming leg. Today's "Log incoming call" records such
-- a call against its firm and contact through the ordinary call-outcome command, and the
-- log has to say that it was *incoming*. Without it an incoming call would read as one
-- more outbound attempt, and the cadence (4 unanswered attempts in 14 days, at least two
-- hours apart, one per business day) would count a call the prospect made.
--
--   * `direction` — `outbound` (every call logged before this migration, and every call
--     placed from Callie or the phone app) or `inbound`. NOT NULL with a default, so every
--     stored row reads `outbound`, which is what each of them was.
--   * `duration_seconds` — how long an incoming call lasted, when David says. Nullable: the
--     length is optional on the form, and an outbound call's length is its session's.
--
-- The outcome stays required: an incoming call is logged with one of 9.1's outcomes like
-- any other, and every reader that parses one keeps parsing it.
--
-- ## What `-- changes:` names, and why
--
--   * `call_logs` — two new columns, one with a default, which changes the content hash of
--     every stored row (docs/greenfield/migrations.md). No stored value changes.
-- ---------------------------------------------------------------------------

ALTER TABLE call_logs
  ADD COLUMN direction text NOT NULL DEFAULT 'outbound',
  ADD COLUMN duration_seconds integer;

ALTER TABLE call_logs
  ADD CONSTRAINT call_logs_direction_known CHECK (direction IN ('outbound', 'inbound')),
  ADD CONSTRAINT call_logs_duration_bounded
    CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds <= 86400));
