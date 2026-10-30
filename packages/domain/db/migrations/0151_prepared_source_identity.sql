-- changes: sourcing_qualification_runs
-- Existing v5/v7 rows, fingerprints, source labels and owner attestations remain unchanged.
ALTER TABLE sourcing_qualification_runs
 ADD COLUMN producer_version text NOT NULL DEFAULT 'qualification-context-v7',
 ADD COLUMN prepared_identity jsonb,
 ADD CONSTRAINT sourcing_qualification_producer_supported
 CHECK(producer_version IN ('qualification-context-v7','prepared-source-identity-v1')),
 ADD CONSTRAINT sourcing_qualification_prepared_identity_shape CHECK(prepared_identity IS NULL OR
  CASE WHEN jsonb_typeof(prepared_identity)='object' THEN
   producer_version='prepared-source-identity-v1' AND retained_identity_decision_id IS NULL
   AND prepared_identity ?& ARRAY['producerVersion','observationId','blockId','contentHash','relevantTextHash','blockTextHash']
   AND prepared_identity-ARRAY['producerVersion','observationId','blockId','contentHash','relevantTextHash','blockTextHash']='{}'::jsonb
   AND jsonb_typeof(prepared_identity->'producerVersion')='string' AND prepared_identity->>'producerVersion'='prepared-source-identity-v1'
   AND jsonb_typeof(prepared_identity->'observationId')='string'
   AND prepared_identity->>'observationId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   AND jsonb_typeof(prepared_identity->'blockId')='string' AND length(prepared_identity->>'blockId') BETWEEN 1 AND 80
   AND jsonb_typeof(prepared_identity->'contentHash')='string' AND prepared_identity->>'contentHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(prepared_identity->'relevantTextHash')='string' AND prepared_identity->>'relevantTextHash' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(prepared_identity->'blockTextHash')='string' AND prepared_identity->>'blockTextHash' ~ '^[a-f0-9]{64}$'
  ELSE false END);

CREATE FUNCTION sourcing_qualification_producer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.producer_version IS DISTINCT FROM OLD.producer_version THEN
  RAISE EXCEPTION 'qualification producer is immutable' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_producer_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER sourcing_qualification_producer_immutable
 AFTER UPDATE ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION sourcing_qualification_producer_immutable();

CREATE FUNCTION sourcing_qualification_prepared_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.prepared_identity IS NOT NULL THEN
   RAISE EXCEPTION 'prepared identity requires terminal completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_identity_immutable';
  END IF;
 ELSIF NEW.prepared_identity IS DISTINCT FROM OLD.prepared_identity THEN
  IF OLD.prepared_identity IS NOT NULL OR OLD.state NOT IN ('pending','running') OR NEW.state<>'review' OR NEW.reason IS NOT NULL THEN
   RAISE EXCEPTION 'prepared identity is immutable after completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_identity_immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER sourcing_qualification_prepared_identity_immutable
 AFTER INSERT OR UPDATE ON sourcing_qualification_runs FOR EACH ROW EXECUTE FUNCTION sourcing_qualification_prepared_identity_immutable();
