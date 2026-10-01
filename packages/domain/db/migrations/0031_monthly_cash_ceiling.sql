-- ---------------------------------------------------------------------------
-- 0031_monthly_cash_ceiling.sql — the month-to-date cash ceiling setting (slice P1)
-- changes: workspace_settings, provider_reservations
--
-- Daily ceilings are not a monthly guarantee: $1.25 of calling and $0.50 of
-- transcription a day, across twenty-two weekdays, already allow $38.50 in a month. Slice
-- P1 (1 October 2026, invariant I2) adds one workspace setting, the month's cash ceiling
-- in cents, enforced when telephony and transcription reserve their cents — atomically
-- with each one's daily ceiling — against everything the workspace spent this calendar
-- month (settled plus open reservations, on the business time zone's calendar).
--
-- ## What `-- changes:` names, and why
--
--   * `workspace_settings` — `workspace_settings_key_known` admits the new key
--     `monthly_cash_ceiling_cents` (`{ "cents": 0..5000 }`), a swap under the same name
--     as 0020's, 0028's and 0030's were. No row is written: a key with no row is its
--     default, $25. Every stored row keeps a key the new CHECK admits, so every existing
--     answer is unchanged.
--
--   * `provider_reservations` — the reply classifier joins the paid-call pattern (P1 fix
--     round 2): `provider_reservations_subject_known` admits `reply_classification`
--     (subject id: the mail message), `provider_reservations_priced_shape` gives it the
--     LLM shape research has (a model and two token bounds, no unit), and the new partial
--     unique index `provider_reservations_one_open_reply` allows at most one open
--     (`reserved` or `calling`) reservation per reply — one active paid obligation. Both
--     CHECKs are swaps under the same names as 0028's; every stored row is `research_run`,
--     `call_session` or `call_transcription` and is admitted exactly as before, and no stored
--     row is a `reply_classification`, so the index starts empty.
--
-- ## Release shape
--
-- `touches-existing` for the constraint swaps and the index; nothing else.
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled',
                           'calling_provider', 'calendar_integration', 'telephony_budget',
                           'voicemail_script', 'call_transcription', 'monthly_cash_ceiling_cents'));

ALTER TABLE provider_reservations
  DROP CONSTRAINT provider_reservations_subject_known,
  ADD CONSTRAINT provider_reservations_subject_known
    CHECK (subject_kind IN ('research_run', 'call_session', 'call_transcription', 'reply_classification')),
  DROP CONSTRAINT provider_reservations_priced_shape,
  ADD CONSTRAINT provider_reservations_priced_shape
    CHECK (
      (subject_kind NOT IN ('research_run', 'reply_classification')
        OR (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL
            AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
      AND
      (subject_kind NOT IN ('call_session', 'call_transcription')
        OR (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL
            AND priced_unit IS NOT NULL AND priced_unit = 'minute' AND max_units IS NOT NULL AND max_units > 0 AND max_units <= 240
            AND unit_price_micros IS NOT NULL AND unit_price_micros >= 0 AND unit_price_micros <= 10000000))
    );

CREATE UNIQUE INDEX provider_reservations_one_open_reply
  ON provider_reservations (workspace_id, subject_id)
  WHERE subject_kind = 'reply_classification' AND state IN ('reserved', 'calling');
