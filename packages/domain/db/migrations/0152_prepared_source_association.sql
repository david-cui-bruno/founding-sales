-- changes: sourcing_qualification_runs
-- Old and queued runs retain legacy capture behavior. This metadata grants no channel authority.
CREATE FUNCTION sourcing_prepared_capture_shape(value jsonb,candidate uuid,revision integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE page jsonb; url jsonb; seen text[]:=ARRAY[]::text[];
BEGIN
 IF (jsonb_typeof(value)='object' AND octet_length(value::text)<=32768
  AND value ?& ARRAY['version','candidateId','candidateRevision','sourceUrl','pages']
  AND value-ARRAY['version','candidateId','candidateRevision','sourceUrl','pages']='{}'::jsonb
  AND value->>'version'='prepared-source-association-v1'
  AND jsonb_typeof(value->'candidateId')='string' AND value->>'candidateId'=candidate::text
  AND jsonb_typeof(value->'candidateRevision')='number' AND value->>'candidateRevision' ~ '^[1-9][0-9]*$'
  AND jsonb_typeof(value->'sourceUrl')='string' AND length(value->>'sourceUrl') BETWEEN 1 AND 500
  AND value->>'sourceUrl' ~ '^https://[^[:space:]]+$'
  AND jsonb_typeof(value->'pages')='array') IS NOT TRUE THEN RETURN false; END IF;
 IF (value->>'candidateRevision')::numeric<>revision OR jsonb_array_length(value->'pages') NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
 FOR page IN SELECT p FROM jsonb_array_elements(value->'pages') p LOOP
  IF (jsonb_typeof(page)='object'
   AND page ?& ARRAY['observationId','url','contentHash','relevantTextHash','retrievedAt','redirectUrls']
   AND page-ARRAY['observationId','url','contentHash','relevantTextHash','retrievedAt','redirectUrls']='{}'::jsonb
   AND jsonb_typeof(page->'observationId')='string'
   AND page->>'observationId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND jsonb_typeof(page->'url')='string' AND length(page->>'url') BETWEEN 1 AND 500
   AND page->>'url' ~ '^https://[^[:space:]]+$'
   AND jsonb_typeof(page->'contentHash')='string' AND page->>'contentHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(page->'relevantTextHash')='string' AND page->>'relevantTextHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(page->'retrievedAt')='string'
   AND page->>'retrievedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
   AND jsonb_typeof(page->'redirectUrls')='array') IS NOT TRUE THEN RETURN false; END IF;
  IF page->>'observationId'=ANY(seen) OR jsonb_array_length(page->'redirectUrls') NOT BETWEEN 2 AND 6 THEN RETURN false; END IF;
  seen:=array_append(seen,page->>'observationId');
  FOR url IN SELECT u FROM jsonb_array_elements(page->'redirectUrls') u LOOP
   IF (jsonb_typeof(url)='string' AND length(url#>>'{}') BETWEEN 1 AND 500 AND url#>>'{}' ~ '^https://[^[:space:]]+$') IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  IF page->'redirectUrls'->>0 IS DISTINCT FROM value->>'sourceUrl'
   OR page->'redirectUrls'->>-1 IS DISTINCT FROM page->>'url' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

ALTER TABLE sourcing_qualification_runs
 ADD COLUMN capture_policy_version text NOT NULL DEFAULT 'legacy',
 ADD COLUMN prepared_capture jsonb,
 ADD CONSTRAINT sourcing_qualification_capture_policy_supported CHECK(capture_policy_version IN ('legacy','prepared-source-association-v1')),
 ADD CONSTRAINT sourcing_qualification_prepared_capture_shape CHECK(prepared_capture IS NULL OR
  (capture_policy_version='prepared-source-association-v1' AND retained_identity_decision_id IS NULL
   AND sourcing_prepared_capture_shape(prepared_capture,candidate_id,candidate_revision)));

CREATE FUNCTION sourcing_qualification_capture_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.capture_policy_version IS DISTINCT FROM OLD.capture_policy_version THEN
  RAISE EXCEPTION 'capture policy is immutable' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_capture_policy_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER sourcing_qualification_capture_policy_immutable
 AFTER UPDATE ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION sourcing_qualification_capture_policy_immutable();

-- Erasing or replacing originals cannot leave their source URLs in a stale manifest.
CREATE FUNCTION sourcing_qualification_capture_source_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.prepared_capture IS NOT NULL AND NEW.observations IS DISTINCT FROM OLD.observations THEN NEW.prepared_capture:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sourcing_qualification_capture_source_erasure BEFORE UPDATE OF observations ON sourcing_qualification_runs
 FOR EACH ROW EXECUTE FUNCTION sourcing_qualification_capture_source_erasure();

CREATE FUNCTION sourcing_qualification_prepared_capture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.prepared_capture IS NOT NULL THEN
   RAISE EXCEPTION 'prepared capture requires terminal completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
  END IF;
 ELSIF NEW.capture_policy_version='prepared-source-association-v1' AND OLD.state NOT IN ('pending','running') AND NEW.state IN ('pending','running') THEN
  RAISE EXCEPTION 'completed capture cannot be reopened' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
 ELSIF NEW.prepared_capture IS DISTINCT FROM OLD.prepared_capture AND NEW.prepared_capture IS NOT NULL THEN
  IF OLD.prepared_capture IS NOT NULL OR OLD.state NOT IN ('pending','running') OR NEW.state NOT IN ('review','unavailable')
   OR jsonb_array_length(NEW.observations)=0 THEN
   RAISE EXCEPTION 'prepared capture is immutable after completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER sourcing_qualification_prepared_capture_immutable
 AFTER INSERT OR UPDATE ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION sourcing_qualification_prepared_capture_immutable();
