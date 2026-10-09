-- changes: call_transcripts, meeting_recordings, provider_reservations
-- Versioned processing receipts contain source identity, never copied source text.
CREATE TABLE crm_extraction_generations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),
  source_revision integer NOT NULL CHECK(source_revision>0),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  requested_by uuid NOT NULL,
  authorization_hash text NOT NULL DEFAULT encode(sha256(convert_to('none/native','UTF8')),'hex') CHECK(authorization_hash ~ '^[a-f0-9]{64}$'),
  context_hash text NOT NULL DEFAULT repeat('0',64) CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  purpose_revision integer NOT NULL DEFAULT 0 CHECK(purpose_revision>=0),
  processor_version text NOT NULL CHECK(length(processor_version) BETWEEN 1 AND 100),
  model_version text CHECK(model_version IS NULL OR length(model_version) BETWEEN 1 AND 200),
  state text NOT NULL CHECK(state IN ('unavailable','pending','processing','complete','failed','stale','deleted','unknown_acceptance')),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,source_kind,source_id,source_revision,source_hash,processor_version,purpose_revision,context_hash,authorization_hash),
  FOREIGN KEY(workspace_id,requested_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_extraction_generations TO app_runtime,migration;
CREATE TABLE crm_extraction_purposes (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  revision integer NOT NULL CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT false,
  endpoint_id text NOT NULL CHECK(length(endpoint_id) BETWEEN 1 AND 100),
  model_version text NOT NULL CHECK(length(model_version) BETWEEN 1 AND 200),
  access_grant_version text NOT NULL CHECK(length(access_grant_version) BETWEEN 1 AND 200),
  data_handling_version text NOT NULL CHECK(length(data_handling_version) BETWEEN 1 AND 200),
  daily_ceiling_cents integer NOT NULL CHECK(daily_ceiling_cents BETWEEN 1 AND 100000),
  monthly_ceiling_cents integer NOT NULL CHECK(monthly_ceiling_cents BETWEEN 1 AND 1000000),
  input_token_price_micros integer NOT NULL CHECK(input_token_price_micros BETWEEN 1 AND 1000000),
  output_token_price_micros integer NOT NULL CHECK(output_token_price_micros BETWEEN 1 AND 1000000),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_extraction_purposes TO app_runtime,migration;
-- Every selected-source lifecycle path (including operational deletion) invalidates old work.
CREATE FUNCTION invalidate_crm_extraction_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revision IS DISTINCT FROM NEW.revision OR OLD.availability IS DISTINCT FROM NEW.availability
     OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
    UPDATE crm_extraction_generations SET
      state=CASE WHEN NEW.availability='deleted' THEN 'deleted' ELSE 'stale' END,
      reason=CASE WHEN NEW.availability='deleted' THEN 'source_deleted' ELSE 'source_changed' END
    WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id AND source_kind='selected_note'
      AND (state NOT IN ('deleted','stale') OR NEW.availability='deleted' AND state='stale')
      AND (NEW.availability<>'available' OR source_revision<>NEW.revision OR source_hash IS DISTINCT FROM NEW.content_hash);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER crm_selected_source_extraction_invalidation AFTER UPDATE ON crm_selected_sources
FOR EACH ROW EXECUTE FUNCTION invalidate_crm_extraction_source();
CREATE TABLE crm_extraction_financial_receipts (
 workspace_id uuid NOT NULL,
 generation_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 job_id uuid NOT NULL,
 fencing_token bigint NOT NULL,
 dispatch_state text NOT NULL CHECK(dispatch_state IN ('reserved','calling','settled','unknown_acceptance','released')),
 endpoint_id text NOT NULL,
 model_version text NOT NULL,
 access_grant_version text NOT NULL,
 data_handling_version text NOT NULL,
 purpose_revision integer NOT NULL,
 input_price_micros integer NOT NULL,
 output_price_micros integer NOT NULL,
 PRIMARY KEY(workspace_id,generation_id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES crm_extraction_generations(workspace_id,id),
 FOREIGN KEY(workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id)
);
CREATE TABLE crm_extraction_claims (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 generation_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('need','objection','commitment')),
 interpretation text NOT NULL CHECK(length(interpretation) BETWEEN 1 AND 1000),
 status text NOT NULL CHECK(status IN ('stated','inferred')),
 locator text NOT NULL CHECK(length(locator) BETWEEN 1 AND 200),
 quote text NOT NULL CHECK(length(quote) BETWEEN 1 AND 2000),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES crm_extraction_generations(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_extraction_financial_receipts,crm_extraction_claims TO app_runtime,migration;
CREATE FUNCTION redact_crm_extraction_claims() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='deleted' OR NEW.state='stale' AND NEW.reason IS DISTINCT FROM 'source_context_changed' THEN
 DELETE FROM crm_extraction_claims WHERE workspace_id=NEW.workspace_id AND generation_id=NEW.id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_extraction_claims_redaction AFTER UPDATE ON crm_extraction_generations FOR EACH ROW EXECUTE FUNCTION redact_crm_extraction_claims();
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction')),
 DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
-- Capture and queue share the source transaction; disabled configuration creates no automatic work.
CREATE FUNCTION enqueue_crm_selected_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured crm_extraction_purposes%ROWTYPE; generation uuid; captured jsonb; context_identity text;
BEGIN
 IF NEW.availability<>'available' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.revision=NEW.revision AND OLD.content_hash IS NOT DISTINCT FROM NEW.content_hash THEN RETURN NEW; END IF;
 SELECT * INTO configured FROM crm_extraction_purposes WHERE workspace_id=NEW.workspace_id AND enabled;
 IF NOT FOUND THEN RETURN NEW; END IF;
 captured:=crm_selected_processing_context(NEW.workspace_id,NEW.id,NEW.revision,NEW.content_hash);
 IF captured IS NULL THEN RETURN NEW; END IF;
 context_identity:=crm_processing_context_hash(captured);
 INSERT INTO crm_extraction_generations(workspace_id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,purpose_revision,model_version,state,context_snapshot,context_hash,source_owner_user_id)
 VALUES(NEW.workspace_id,NEW.id,'selected_note',NEW.revision,NEW.content_hash,NEW.owner_user_id,'crm-extract-v1',configured.revision,configured.model_version,'pending',captured,context_identity,NEW.owner_user_id) ON CONFLICT DO NOTHING RETURNING id INTO generation;
 IF generation IS NULL THEN
 SELECT id INTO generation FROM crm_extraction_generations WHERE workspace_id=NEW.workspace_id AND source_kind='selected_note' AND source_id=NEW.id AND source_revision=NEW.revision AND source_hash=NEW.content_hash AND purpose_revision=configured.revision AND processor_version='crm-extract-v1' AND context_hash=context_identity;
 END IF;
 INSERT INTO jobs(workspace_id,kind,payload,idempotency_key,max_attempts)
 VALUES(NEW.workspace_id,'crm.extract',jsonb_build_object('generationId',generation),'crm-extract:'||generation::text,3) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_selected_extraction_enqueue',MESSAGE=SQLERRM;
END;
$$;
CREATE CONSTRAINT TRIGGER crm_selected_extraction_enqueue AFTER INSERT OR UPDATE ON crm_selected_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enqueue_crm_selected_extraction();
ALTER TABLE call_transcripts ADD COLUMN crm_revision integer NOT NULL DEFAULT 1 CHECK(crm_revision>0);
CREATE FUNCTION version_crm_call_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.utterances IS DISTINCT FROM NEW.utterances OR OLD.provider IS DISTINCT FROM NEW.provider OR OLD.model IS DISTINCT FROM NEW.model OR OLD.language IS DISTINCT FROM NEW.language OR OLD.duration_seconds IS DISTINCT FROM NEW.duration_seconds THEN NEW.crm_revision=OLD.crm_revision+1;
 ELSE NEW.crm_revision=OLD.crm_revision;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_call_transcript_version BEFORE UPDATE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION version_crm_call_transcript();
ALTER TABLE crm_extraction_generations ADD COLUMN original_firm_id uuid,
 ADD FOREIGN KEY(workspace_id,original_firm_id) REFERENCES firms(workspace_id,id);
CREATE FUNCTION invalidate_crm_native_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity uuid; kind text; changed boolean;
BEGIN
 IF TG_TABLE_NAME='call_transcripts' THEN identity=OLD.call_session_id; kind='call_transcript';
 ELSE identity=OLD.id; kind='meeting_transcript'; END IF;
 IF TG_OP='DELETE' THEN
 UPDATE crm_extraction_generations SET state='deleted',reason='source_deleted' WHERE workspace_id=OLD.workspace_id AND source_id=identity AND source_kind=kind AND state<>'deleted';
 RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='call_transcripts' THEN changed=OLD.crm_revision IS DISTINCT FROM NEW.crm_revision;
 ELSE changed=OLD.version IS DISTINCT FROM NEW.version OR OLD.utterances IS DISTINCT FROM NEW.utterances; END IF;
 IF changed THEN
 UPDATE crm_extraction_generations SET state='stale',reason='source_changed' WHERE workspace_id=NEW.workspace_id AND source_id=identity AND source_kind=kind AND state NOT IN ('deleted','stale');
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_call_extraction_invalidation AFTER UPDATE OR DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_native_extraction();
CREATE TRIGGER crm_meeting_extraction_invalidation AFTER UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_native_extraction();

ALTER TABLE meeting_recordings ADD COLUMN crm_capture_owner_user_id uuid, ADD CONSTRAINT meeting_recordings_crm_capture_owner_fk FOREIGN KEY(workspace_id,crm_capture_owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id);

CREATE INDEX crm_extraction_dispatched_recovery ON crm_extraction_financial_receipts(workspace_id,generation_id) WHERE dispatch_state='calling';
CREATE INDEX crm_extraction_source_history ON crm_extraction_generations(workspace_id,source_kind,source_id,observed_at DESC,id DESC);

ALTER TABLE crm_extraction_financial_receipts
 ADD CONSTRAINT crm_financial_fence_positive CHECK(fencing_token>0),
 ADD CONSTRAINT crm_financial_purpose_positive CHECK(purpose_revision>0),
 ADD CONSTRAINT crm_financial_endpoint_bounded CHECK(length(endpoint_id) BETWEEN 1 AND 100),
 ADD CONSTRAINT crm_financial_model_bounded CHECK(length(model_version) BETWEEN 1 AND 200),
 ADD CONSTRAINT crm_financial_grant_bounded CHECK(length(access_grant_version) BETWEEN 1 AND 200),
 ADD CONSTRAINT crm_financial_policy_bounded CHECK(length(data_handling_version) BETWEEN 1 AND 200),
 ADD CONSTRAINT crm_financial_input_price_bounded CHECK(input_price_micros BETWEEN 1 AND 1000000),
 ADD CONSTRAINT crm_financial_output_price_bounded CHECK(output_price_micros BETWEEN 1 AND 1000000);
REVOKE DELETE ON crm_extraction_financial_receipts FROM app_runtime,migration;

-- Identity context has no arbitrary text slots, including nested relationship rows.
CREATE FUNCTION crm_extraction_context_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE element jsonb; field text; uuid_pattern text := '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
BEGIN
 IF value IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR value-ARRAY['personId','firmIds','relationships','review','mailContexts']<>'{}'::jsonb
 OR NOT value ?& ARRAY['personId','firmIds','relationships','review']
 OR jsonb_typeof(value->'firmIds')<>'array' OR jsonb_typeof(value->'relationships')<>'array'
 OR jsonb_typeof(value->'review')<>'string' OR value->>'review' NOT IN ('current','required') THEN RETURN false; END IF;
 IF value ? 'mailContexts' THEN
  IF jsonb_typeof(value->'mailContexts')<>'array' OR jsonb_array_length(value->'mailContexts')>100 THEN RETURN false; END IF;
  FOR element IN SELECT jsonb_array_elements(value->'mailContexts') LOOP
   IF jsonb_typeof(element)<>'object' OR element-ARRAY['contextId','sourceRevision','personId','firmId','opportunityId','operationalMatchId','operationalMatchHash','kind']<>'{}'::jsonb
   OR NOT element ?& ARRAY['contextId','sourceRevision','personId','firmId','opportunityId','operationalMatchId','operationalMatchHash','kind']
   OR jsonb_typeof(element->'contextId')<>'string' OR element->>'contextId' !~ uuid_pattern
   OR jsonb_typeof(element->'sourceRevision')<>'number' OR element->>'sourceRevision' !~ '^[1-9][0-9]{0,9}$'
   OR jsonb_typeof(element->'kind')<>'string' OR element->>'kind' NOT IN ('acquired','reviewed') THEN RETURN false; END IF;
   IF (element->>'sourceRevision')::bigint>2147483647 THEN RETURN false; END IF;
   FOREACH field IN ARRAY ARRAY['personId','firmId','opportunityId','operationalMatchId'] LOOP
    IF element->field<>'null'::jsonb AND (jsonb_typeof(element->field)<>'string' OR element->>field !~ uuid_pattern) THEN RETURN false; END IF;
   END LOOP;
   IF element->'operationalMatchHash'<>'null'::jsonb AND (jsonb_typeof(element->'operationalMatchHash')<>'string' OR element->>'operationalMatchHash' !~ '^[a-f0-9]{64}$') THEN RETURN false; END IF;
   IF (element->'operationalMatchId'='null'::jsonb)<>(element->'operationalMatchHash'='null'::jsonb) THEN RETURN false; END IF;
  END LOOP;
 END IF;
 IF octet_length(value::text)>(CASE WHEN jsonb_typeof(value->'mailContexts')='array' AND jsonb_array_length(value->'mailContexts')>0 THEN 64000 ELSE 20000 END) THEN RETURN false; END IF;
 IF value->'personId'<>'null'::jsonb AND (jsonb_typeof(value->'personId')<>'string' OR value->>'personId' !~ uuid_pattern) THEN RETURN false; END IF;
 IF jsonb_array_length(value->'firmIds')>100 OR jsonb_array_length(value->'relationships')>100 THEN RETURN false; END IF;
 FOR element IN SELECT jsonb_array_elements(value->'firmIds') LOOP
  IF jsonb_typeof(element)<>'string' OR element #>> '{}' !~ uuid_pattern THEN RETURN false; END IF;
 END LOOP;
 FOR element IN SELECT jsonb_array_elements(value->'relationships') LOOP
  IF jsonb_typeof(element)<>'object' OR element-ARRAY['relationshipId','revision']<>'{}'::jsonb
  OR NOT element ?& ARRAY['relationshipId','revision'] OR jsonb_typeof(element->'relationshipId')<>'string'
  OR element->>'relationshipId' !~ uuid_pattern OR jsonb_typeof(element->'revision')<>'number'
  OR element->>'revision' !~ '^[1-9][0-9]{0,9}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE crm_extraction_generations ADD COLUMN context_snapshot jsonb,
 ADD CONSTRAINT crm_extraction_context_body_free CHECK(crm_extraction_context_valid(context_snapshot));
ALTER TABLE crm_extraction_claims ADD COLUMN claim_hash text NOT NULL CHECK(claim_hash ~ '^[a-f0-9]{64}$');

CREATE FUNCTION crm_processing_context_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to(coalesce(value->>'personId','')||'|'||
 coalesce((SELECT string_agg(element #>> '{}',',' ORDER BY element #>> '{}') FROM jsonb_array_elements(value->'firmIds') element),'')||'|'||
 coalesce((SELECT string_agg((element->>'relationshipId')||':'||(element->>'revision'),',' ORDER BY element->>'relationshipId',(element->>'revision')::bigint) FROM jsonb_array_elements(value->'relationships') element),'')||
 CASE WHEN jsonb_typeof(value->'mailContexts')='array' AND jsonb_array_length(value->'mailContexts')>0 THEN '|mail:['||
 (SELECT string_agg(tuple,',' ORDER BY tuple COLLATE "C") FROM (SELECT regexp_replace(jsonb_build_array(element->'contextId',element->'sourceRevision',element->'personId',element->'firmId',element->'opportunityId',element->'operationalMatchId',element->'operationalMatchHash',element->'kind')::text,'\s','','g') AS tuple FROM jsonb_array_elements(value->'mailContexts') element) refs)||']' ELSE '' END,'UTF8')),'hex');
$$;
CREATE FUNCTION crm_selected_processing_context(ws uuid,source uuid,rev integer,hash text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('personId',s.person_id,'firmIds',to_jsonb(ARRAY(SELECT firm_id::text FROM (SELECT s.firm_id UNION SELECT c.firm_id FROM crm_source_relationship_contexts c WHERE c.workspace_id=ws AND c.source_id=source AND c.source_revision=rev AND c.source_hash=hash) firms WHERE firm_id IS NOT NULL ORDER BY firm_id)),
 'relationships',coalesce((SELECT jsonb_agg(jsonb_build_object('relationshipId',c.relationship_id,'revision',c.relationship_revision) ORDER BY c.relationship_id,c.relationship_revision) FROM crm_source_relationship_contexts c WHERE c.workspace_id=ws AND c.source_id=source AND c.source_revision=rev AND c.source_hash=hash),'[]'::jsonb),
 'review',CASE WHEN EXISTS(SELECT 1 FROM crm_source_relationship_contexts c WHERE c.workspace_id=ws AND c.source_id=source AND c.source_revision=rev AND c.source_hash=hash AND c.review='required') THEN 'required' ELSE 'current' END)
 FROM crm_selected_sources s WHERE s.workspace_id=ws AND s.id=source AND s.revision=rev AND s.content_hash=hash AND s.availability='available';
$$;

-- Body-free original association survives the original transcript row's removal.
ALTER TABLE crm_extraction_generations ADD COLUMN original_meeting_id uuid,ADD COLUMN original_recording_id uuid,
 ADD COLUMN source_owner_user_id uuid,
 ADD CONSTRAINT crm_extraction_source_owner_fk FOREIGN KEY(workspace_id,source_owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id);
CREATE INDEX crm_extraction_record_history ON crm_extraction_generations(workspace_id,original_meeting_id,source_owner_user_id,observed_at DESC,id DESC) WHERE original_meeting_id IS NOT NULL;

-- Native mail remains the sole body authority; every copy lifecycle invalidates
-- projections but leaves ambiguous financial receipts conserved independently.
CREATE FUNCTION invalidate_crm_mail_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_deleted boolean;
BEGIN
 IF TG_OP='DELETE' OR OLD.source_revision IS DISTINCT FROM NEW.source_revision
    OR OLD.content_hash IS DISTINCT FROM NEW.content_hash OR OLD.availability IS DISTINCT FROM NEW.availability THEN
  is_deleted := TG_OP='DELETE' OR NEW.availability='deleted';
  UPDATE crm_extraction_generations SET state=CASE WHEN is_deleted THEN 'deleted' ELSE 'stale' END,
    reason=CASE WHEN is_deleted THEN 'source_deleted' ELSE 'source_changed' END
  WHERE workspace_id=OLD.workspace_id AND source_id=OLD.source_id AND source_kind='mail'
    AND (state NOT IN ('deleted','stale') OR is_deleted AND state='stale');
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_mail_extraction_invalidation AFTER UPDATE OR DELETE ON crm_mail_sources
FOR EACH ROW EXECUTE FUNCTION invalidate_crm_mail_extraction();
