-- 0033_classifier_provider_refused.sql — the reply classifier's model-call log admits
-- `provider_refused` (slice REL1).
--
-- changes: mail_classification_calls
--
-- Names the table because its CHECK constraint is swapped (shape changes; no row does).
--
-- A request the API refuses with a 4xx other than 408 was refused before generation: it
-- billed nothing and is not retried. Until now the call was recorded as `provider_error`,
-- the word for an ambiguous failure, because the CHECK below had no other. Existing rows
-- are untouched: every stored outcome stays admitted.
ALTER TABLE mail_classification_calls
  DROP CONSTRAINT mail_classification_calls_outcome_known,
  ADD CONSTRAINT mail_classification_calls_outcome_known
    CHECK (outcome IN ('accepted', 'refusal', 'malformed', 'schema_invalid', 'excerpt_unverified',
                       'provider_error', 'provider_refused', 'disabled', 'capped', 'not_applicable'));
