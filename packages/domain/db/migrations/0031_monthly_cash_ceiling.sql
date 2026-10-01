-- ---------------------------------------------------------------------------
-- 0031_monthly_cash_ceiling.sql — the month-to-date cash ceiling setting (slice P1)
-- changes: workspace_settings
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
-- ## Release shape
--
-- `touches-existing` for the constraint swap; nothing else.
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('business_time_zone', 'postal_address', 'sending_enabled',
                           'calling_provider', 'calendar_integration', 'telephony_budget',
                           'voicemail_script', 'call_transcription', 'monthly_cash_ceiling_cents'));
