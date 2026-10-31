-- changes: sourcing_qualification_runs,evidence_items,sourcing_candidates,sourcing_candidate_discovery_origins,audit_events
-- Future v2 requests retain actual same-site redirects; old policy/rows stay immutable.
CREATE OR REPLACE FUNCTION sourcing_prepared_capture_shape(value jsonb,candidate uuid,revision integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE page jsonb; url jsonb; seen text[]:=ARRAY[]::text[];
BEGIN
 IF (jsonb_typeof(value)='object' AND octet_length(value::text)<=32768
  AND value ?& ARRAY['version','candidateId','candidateRevision','sourceUrl','pages']
  AND value-ARRAY['version','candidateId','candidateRevision','sourceUrl','pages']='{}'::jsonb
  AND value->>'version' IN ('prepared-source-association-v1','prepared-source-association-v2')
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


ALTER TABLE sourcing_qualification_runs DROP CONSTRAINT sourcing_qualification_capture_policy_supported;
ALTER TABLE sourcing_qualification_runs ADD CONSTRAINT sourcing_qualification_capture_policy_supported
 CHECK(capture_policy_version IN ('legacy','prepared-source-association-v1','prepared-source-association-v2'));
ALTER TABLE sourcing_qualification_runs DROP CONSTRAINT sourcing_qualification_prepared_capture_shape;
ALTER TABLE sourcing_qualification_runs ADD CONSTRAINT sourcing_qualification_prepared_capture_shape CHECK(prepared_capture IS NULL OR
 (capture_policy_version IN ('prepared-source-association-v1','prepared-source-association-v2')
  AND prepared_capture->>'version'=capture_policy_version AND retained_identity_decision_id IS NULL
  AND sourcing_prepared_capture_shape(prepared_capture,candidate_id,candidate_revision)));
CREATE OR REPLACE FUNCTION sourcing_qualification_prepared_capture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.prepared_capture IS NOT NULL THEN
   RAISE EXCEPTION 'prepared capture requires terminal completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
  END IF;
 ELSIF NEW.capture_policy_version IN ('prepared-source-association-v1','prepared-source-association-v2') AND OLD.state NOT IN ('pending','running') AND NEW.state IN ('pending','running') THEN
  RAISE EXCEPTION 'completed capture cannot be reopened' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
 ELSIF NEW.prepared_capture IS DISTINCT FROM OLD.prepared_capture AND NEW.prepared_capture IS NOT NULL THEN
  IF OLD.prepared_capture IS NOT NULL OR OLD.state NOT IN ('pending','running') OR NEW.state NOT IN ('review','unavailable')
   OR jsonb_array_length(NEW.observations)=0 THEN
   RAISE EXCEPTION 'prepared capture is immutable after completion' USING ERRCODE='23514',CONSTRAINT='sourcing_qualification_prepared_capture_immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Source-loss owners already hold this lifecycle BEFORE candidate/evidence rows.
-- Refuse missing custody rather than acquiring a reverse-order advisory lock here.
CREATE FUNCTION erase_prepared_capture_dependencies(w uuid,urls text[],lost_hash text DEFAULT NULL,changed_candidate uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sourcing_qualification_runs r WHERE r.workspace_id=w
  AND r.capture_policy_version='prepared-source-association-v2' AND r.prepared_capture IS NOT NULL
  AND (r.candidate_id=changed_candidate OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.prepared_capture->'pages') p,
   jsonb_array_elements_text(p->'redirectUrls') u WHERE rtrim(u,'/')=ANY(urls)
    OR encode(sha256(convert_to(rtrim(u,'/'),'UTF8')),'hex')=lost_hash))) THEN RETURN; END IF;
 IF NOT calling_preparation_lock_held('sourcing-discovery-review:'||w::text,'ExclusiveLock') THEN
  RAISE EXCEPTION 'Capture erasure requires source lifecycle before rows' USING ERRCODE='40001';
 END IF;
 UPDATE sourcing_qualification_runs r SET prepared_capture=NULL WHERE r.workspace_id=w
  AND r.capture_policy_version='prepared-source-association-v2' AND r.prepared_capture IS NOT NULL
  AND (r.candidate_id=changed_candidate OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.prepared_capture->'pages') p,
   jsonb_array_elements_text(p->'redirectUrls') u WHERE rtrim(u,'/')=ANY(urls)
    OR encode(sha256(convert_to(rtrim(u,'/'),'UTF8')),'hex')=lost_hash));
END $$;
CREATE FUNCTION prepared_capture_dependency_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE urls text[]:=ARRAY[]::text[]; own_candidate uuid;
BEGIN
 IF TG_TABLE_NAME='evidence_items' THEN
  IF TG_OP='INSERT' THEN
   IF (NEW.retention_expires_at IS NOT NULL OR NOT NEW.terms_allow_retention) IS NOT TRUE THEN RETURN NEW; END IF;
   urls:=ARRAY[rtrim(NEW.source_reference,'/')];
  ELSE
   IF TG_OP='UPDATE' AND (NEW.source_reference,NEW.content_hash,NEW.retrieved_at,NEW.terms_allow_retention,NEW.retention_expires_at)
    IS NOT DISTINCT FROM (OLD.source_reference,OLD.content_hash,OLD.retrieved_at,OLD.terms_allow_retention,OLD.retention_expires_at) THEN RETURN NEW; END IF;
   IF TG_OP='UPDATE' THEN urls:=ARRAY[rtrim(OLD.source_reference,'/'),rtrim(NEW.source_reference,'/')];
   ELSE urls:=ARRAY[rtrim(OLD.source_reference,'/')]; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='audit_events' THEN
  IF NEW.action='sourcing.manual_source_retention_expired' AND NEW.subject_kind='sourcing_source_hash' THEN
   PERFORM erase_prepared_capture_dependencies(NEW.workspace_id,urls,NEW.subject_id); END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='sourcing_candidates' THEN
  IF TG_OP='DELETE' THEN own_candidate:=OLD.id;urls:=ARRAY[rtrim(OLD.payload->>'sourceUrl','/'),rtrim(OLD.source_check->'lastSuccess'->>'url','/')];
  ELSE
   IF (NEW.revision,NEW.payload,NEW.status) IS DISTINCT FROM (OLD.revision,OLD.payload,OLD.status) THEN own_candidate:=OLD.id; END IF;
   IF NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN('source_unavailable','source_not_permitted','no_readable_text') THEN
    SELECT array_agg(rtrim(url,'/')) INTO urls FROM (SELECT NEW.payload->>'sourceUrl' url UNION ALL SELECT NEW.source_check->'lastSuccess'->>'url'
     UNION ALL SELECT source->>'sourceUrl' FROM sourcing_candidate_discovery_origins WHERE workspace_id=NEW.workspace_id AND candidate_id=NEW.id) refs;
   END IF;
  END IF;
 ELSE own_candidate:=OLD.candidate_id;urls:=ARRAY[rtrim(OLD.source->>'sourceUrl','/')];
 END IF;
 IF TG_OP='INSERT' THEN PERFORM erase_prepared_capture_dependencies(NEW.workspace_id,urls);
 ELSE PERFORM erase_prepared_capture_dependencies(OLD.workspace_id,urls,NULL,own_candidate); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER prepared_capture_evidence_erasure BEFORE UPDATE OF source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at OR DELETE ON evidence_items FOR EACH ROW EXECUTE FUNCTION prepared_capture_dependency_erasure();
CREATE TRIGGER prepared_capture_evidence_denial AFTER INSERT ON evidence_items FOR EACH ROW EXECUTE FUNCTION prepared_capture_dependency_erasure();
CREATE TRIGGER prepared_capture_audit_loss AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION prepared_capture_dependency_erasure();
CREATE TRIGGER prepared_capture_candidate_erasure BEFORE UPDATE OF revision,payload,status,source_check OR DELETE ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION prepared_capture_dependency_erasure();
CREATE TRIGGER prepared_capture_origin_erasure BEFORE UPDATE OR DELETE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION prepared_capture_dependency_erasure();
