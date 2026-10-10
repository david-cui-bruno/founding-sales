-- changes: crm_acquisition_diagnostic_reads
-- Preserve historical reservations; their five-unit schedule was not independently verified.
ALTER TABLE crm_acquisition_diagnostic_reads
  ADD COLUMN quota_schedule_version text NOT NULL DEFAULT 'legacy-v89-recorded-unverified';
ALTER TABLE crm_acquisition_diagnostic_reads
  ALTER COLUMN quota_schedule_version SET DEFAULT 'gmail-2026-05-01';
ALTER TABLE crm_acquisition_diagnostic_reads
  DROP CONSTRAINT crm_diagnostic_operation_units;
ALTER TABLE crm_acquisition_diagnostic_reads
  ADD CONSTRAINT crm_diagnostic_quota_schedule CHECK (
    quota_schedule_version IN ('legacy-v89-recorded-unverified', 'gmail-2026-05-01')
  );
ALTER TABLE crm_acquisition_diagnostic_reads
  ADD CONSTRAINT crm_diagnostic_operation_units CHECK (
    quota_schedule_version NOT IN ('legacy-v89-recorded-unverified', 'gmail-2026-05-01')
    OR units NOT BETWEEN 1 AND 1000
    OR (operation IN ('profile_before', 'profile_after') AND units = 1)
    OR (operation IN ('metadata', 'body') AND units = CASE
      WHEN quota_schedule_version = 'gmail-2026-05-01' THEN 20 ELSE 5 END)
  );

CREATE FUNCTION crm_acquisition_diagnostic_current_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quota_schedule_version = 'legacy-v89-recorded-unverified' THEN
    RAISE EXCEPTION 'Current quota schedule required'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_diagnostic_current_dispatch';
  END IF;
  -- The foreign key remains responsible for absent authority; do not hide its exact constraint.
  IF EXISTS (
    SELECT 1 FROM crm_acquisition_diagnostic_authorizations a
    WHERE a.workspace_id = NEW.workspace_id AND a.id = NEW.authorization_id
      AND (a.authorization_document->>'schemaVersion' IS DISTINCT FROM '90'
        OR a.authorization_document->>'metadataUnits' IS DISTINCT FROM '20'
        OR a.authorization_document->>'bodyUnits' IS DISTINCT FROM '20')
  ) THEN
    RAISE EXCEPTION 'Current quota authority required'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_diagnostic_current_dispatch';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER crm_acquisition_diagnostic_current_dispatch
  BEFORE INSERT ON crm_acquisition_diagnostic_reads
  FOR EACH ROW EXECUTE FUNCTION crm_acquisition_diagnostic_current_dispatch();
