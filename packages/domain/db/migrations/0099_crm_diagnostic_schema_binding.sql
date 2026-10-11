-- changes: crm_acquisition_diagnostic_reads
-- Preserve all historical authority/reservations. New dispatch must match the actual
-- applied database schema; checked runtime independently binds the same source schema.
CREATE OR REPLACE FUNCTION crm_acquisition_diagnostic_current_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quota_schedule_version = 'legacy-v89-recorded-unverified' THEN
    RAISE EXCEPTION 'Current quota schedule required'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_diagnostic_current_dispatch';
  END IF;
  -- The foreign key remains responsible for absent authority; do not hide its exact constraint.
  IF EXISTS (
    SELECT 1 FROM crm_acquisition_diagnostic_authorizations a
    WHERE a.workspace_id = NEW.workspace_id AND a.id = NEW.authorization_id
      AND (a.authorization_document->>'schemaVersion' IS DISTINCT FROM (SELECT max(version)::text FROM schema_versions)
        OR a.authorization_document->>'metadataUnits' IS DISTINCT FROM '20'
        OR a.authorization_document->>'bodyUnits' IS DISTINCT FROM '20')
  ) THEN
    RAISE EXCEPTION 'Current quota authority required'
      USING ERRCODE = '23514', CONSTRAINT = 'crm_diagnostic_current_dispatch';
  END IF;
  RETURN NEW;
END; $$;
