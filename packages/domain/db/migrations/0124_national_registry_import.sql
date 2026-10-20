-- changes: national_registry_snapshots
-- Acquisition metadata is local integrity evidence, not an FTC attestation.
ALTER TABLE national_registry_snapshots
  ADD COLUMN acquisition_id uuid,
  ADD COLUMN source_format text,
  ADD COLUMN validated_at timestamptz,
  ADD COLUMN validation_metadata jsonb;

CREATE FUNCTION national_registry_validation_metadata_valid(value jsonb, covered text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  artifact jsonb;
  field text;
  codes text[] := ARRAY[]::text[];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  IF pg_column_size(value) > 8192 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(value)) <> 3
     OR NOT (value ?& ARRAY['version','parser_version','artifacts']) THEN RETURN false; END IF;
  IF value->'version' IS DISTINCT FROM '1'::jsonb
     OR value->>'parser_version' IS DISTINCT FROM 'national-dnc-full-v1'
     OR jsonb_typeof(value->'artifacts') <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'artifacts') <> 5 THEN RETURN false; END IF;
  FOR artifact IN SELECT item FROM jsonb_array_elements(value->'artifacts') AS parts(item)
  LOOP
    IF jsonb_typeof(artifact) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(artifact)) <> 7
       OR NOT (artifact ?& ARRAY['area_code','archive_sha256','archive_bytes',
         'uncompressed_sha256','uncompressed_bytes','record_count','crc32']) THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['area_code','archive_sha256','uncompressed_sha256','crc32']
    LOOP
      IF jsonb_typeof(artifact->field) <> 'string' THEN RETURN false; END IF;
    END LOOP;
    IF (artifact->>'area_code') !~ '^[2-9][0-9]{2}$'
       OR (artifact->>'archive_sha256') !~ '^[a-f0-9]{64}$'
       OR (artifact->>'uncompressed_sha256') !~ '^[a-f0-9]{64}$'
       OR (artifact->>'crc32') !~ '^[a-f0-9]{8}$' THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['archive_bytes','uncompressed_bytes','record_count']
    LOOP
      IF jsonb_typeof(artifact->field) <> 'number' THEN RETURN false; END IF;
      IF (artifact->>field) !~ '^(0|[1-9][0-9]{0,12})$' THEN RETURN false; END IF;
      IF (artifact->>field)::numeric > 1000000000000 THEN RETURN false; END IF;
    END LOOP;
    IF (artifact->>'archive_bytes')::numeric <= 0 THEN RETURN false; END IF;
    -- No invented minimum record count for an official empty full list.
    IF (artifact->>'area_code') = ANY(codes) THEN RETURN false; END IF;
    codes := array_append(codes, artifact->>'area_code');
  END LOOP;
  RETURN (SELECT array_agg(code ORDER BY code) FROM unnest(codes) AS entries(code))
    IS NOT DISTINCT FROM covered;
END;
$$;

ALTER TABLE national_registry_snapshots
  ADD CONSTRAINT national_registry_snapshots_import_metadata CHECK (
    (acquisition_id IS NULL AND source_format IS NULL AND validated_at IS NULL AND validation_metadata IS NULL)
    OR
    (acquisition_id IS NOT NULL AND source_format IS NOT NULL AND validated_at IS NOT NULL
      AND validation_metadata IS NOT NULL
      AND source_format IN ('ftc_full_flat_comma_v1','ftc_full_flat_10digit_v1')
      AND covered_area_codes = ARRAY['401','508','617','774','857']::text[]
      AND validated_at >= downloaded_at
      AND national_registry_validation_metadata_valid(validation_metadata,covered_area_codes))
  );

CREATE UNIQUE INDEX national_registry_snapshots_acquisition
  ON national_registry_snapshots(workspace_id,acquisition_id)
  WHERE acquisition_id IS NOT NULL;

-- Preserve legacy publications without inventing acquisition proof.
-- New publications require validated full metadata. Gate FIRST, snapshot locks SECOND.
CREATE FUNCTION guard_national_registry_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL THEN
    IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
      RAISE EXCEPTION 'published registry snapshot is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'registry snapshot revocation is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.revoked_at IS NOT NULL AND NEW.revoked_at > clock_timestamp() THEN
      RAISE EXCEPTION 'registry revocation cannot be future dated' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    IF NOT NEW.complete OR NEW.revoked_at IS NOT NULL OR NEW.acquisition_id IS NULL
       OR NEW.source_format IS NULL OR NEW.validation_metadata IS NULL OR NEW.validated_at IS NULL
       OR NEW.published_at < NEW.validated_at OR NEW.published_at > clock_timestamp()
       OR NEW.receipt_reference !~ '^[A-Za-z0-9_:-]{1,128}$' THEN
      RAISE EXCEPTION 'registry publication requires validated complete full download' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER national_registry_snapshots_publication_guard
  BEFORE INSERT OR UPDATE ON national_registry_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_national_registry_publication();

REVOKE ALL ON FUNCTION guard_national_registry_publication() FROM PUBLIC;
-- No raw registry table. The exclusive-gated importer checks exact endpoint
-- membership and all-endpoint completeness, never infers it from JSON counts.
