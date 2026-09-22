-- ---------------------------------------------------------------------------
-- 0015_footer.sql — the footer is the sign-off and the stop line (lane G20)
--
-- David decided on 22 September 2026 that an automated email carries no postal
-- address. `docs/decisions/g20-automated-email-carries-no-postal-address.md`
-- records the decision, that it was made after the compliance risk was put to
-- him, and the three lines of revision 3 it deviates from (303, 350, 436).
--
-- What stays: 12.6 in full. Every approved body still ends with the sign-off and
-- then `Reply "stop" and I will not email you again.`, and there is still no web
-- unsubscribe link — `template_versions_no_unsubscribe_link` and
-- `template_versions_approved_has_stop_line` are untouched by this file.
--
-- This is a contract migration: it removes schema rather than adding it, so
-- `packages/domain/db/schemaRange.ts` moves both service minima to 15 in the same
-- release. A binary that still names `footer_postal_address` cannot run after
-- this, and a binary that no longer names it cannot insert before it, so the two
-- ranges do not overlap and Appendix G 22 asserts the refusal.
--
-- Three things change:
--
--   * `template_versions.footer_postal_address` is dropped, together with the
--     CHECK that bounded it. `DROP COLUMN` takes the constraint with it, so the
--     CHECK is not named separately.
--   * `assert_approved_template_immutable` is replaced without the column. The
--     function is the one migration 0012 last wrote; this is the same body minus
--     one comparison, so an approved version stays immutable across every column
--     an approver approved.
--   * `workspace_settings_key_known` loses `postal_footer`. There is no postal
--     footer to configure, so the slice is not a slice.
-- ---------------------------------------------------------------------------

ALTER TABLE template_versions
  DROP COLUMN footer_postal_address;

-- Migration 0009 wrote this trigger function and 0012 extended it to the five
-- personalization columns. This is 0012's body with the dropped column removed;
-- every other comparison is unchanged, because the approval is still an approval
-- of bytes.
CREATE OR REPLACE FUNCTION assert_approved_template_immutable() RETURNS trigger
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
     OR NEW.required_variables IS DISTINCT FROM OLD.required_variables
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id
     OR NEW.personalization_strategy IS DISTINCT FROM OLD.personalization_strategy
     OR NEW.generator_version IS DISTINCT FROM OLD.generator_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.evidence_item_ids IS DISTINCT FROM OLD.evidence_item_ids
     OR NEW.generated_block IS DISTINCT FROM OLD.generated_block THEN
    RAISE EXCEPTION 'an approved template version is immutable; publish a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- The settings slice
--
-- A CHECK cannot be narrowed while a row breaks it, so the rows go first. Nothing
-- has ever run in production, so on every database this statement will ever meet
-- it deletes nothing — but it is written as though it deletes something, because
-- a migration that is only correct on an empty database is a migration nobody can
-- run twice.
--
-- The delete is the whole history of the slice, superseded versions included:
-- a superseded `postal_footer` row would still be a row the narrowed CHECK
-- refuses, and keeping the history of a setting that no longer exists would leave
-- `GET /settings/history` able to answer about a key `SETTING_KEYS` does not have.
--
-- `workspace_settings` is not append-only. Migration 0013 granted
-- `SELECT, INSERT, UPDATE` and revoked nothing, and the audit-immutable tables are
-- `audit_events` and `suppression_events`, neither of which is touched here.
-- ---------------------------------------------------------------------------
DELETE FROM workspace_settings WHERE setting_key = 'postal_footer';

ALTER TABLE workspace_settings
  DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
    CHECK (setting_key IN ('alert_thresholds', 'business_time_zone', 'client_version_range',
                           'sending_enabled'));
