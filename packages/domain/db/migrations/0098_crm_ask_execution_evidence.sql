-- changes: crm_capability_authority_receipts, crm_ask_requests, crm_ask_admitted_sources, crm_ask_admitted_records, crm_ask_history_dependencies, crm_ask_request_windows, crm_selected_sources, crm_mail_sources, call_transcripts, meeting_transcripts
CREATE TABLE crm_ask_admitted_sources (
 workspace_id uuid NOT NULL,request_id uuid NOT NULL,request_version integer NOT NULL CHECK(request_version>0),request_epoch integer NOT NULL CHECK(request_epoch>0),
 admission_ordinal integer NOT NULL DEFAULT 1 CHECK(admission_ordinal BETWEEN 1 AND 10),
 source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),source_id uuid NOT NULL,source_revision integer NOT NULL CHECK(source_revision>0),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 context_snapshot jsonb NOT NULL CHECK(crm_extraction_context_valid(context_snapshot)),original_access_closure jsonb NOT NULL CHECK(crm_access_closure_valid(original_access_closure)),
 PRIMARY KEY(workspace_id,request_id,source_kind,source_id),CONSTRAINT crm_ask_admitted_source_order UNIQUE(workspace_id,request_id,admission_ordinal),FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id)
);
CREATE TABLE crm_ask_admitted_records (
 workspace_id uuid NOT NULL,request_id uuid NOT NULL,request_version integer NOT NULL CHECK(request_version>0),request_epoch integer NOT NULL CHECK(request_epoch>0),record_kind text NOT NULL CHECK(record_kind IN ('firm','person')),record_id uuid NOT NULL,
 record_snapshot jsonb NOT NULL CHECK(jsonb_typeof(record_snapshot)='object' AND octet_length(record_snapshot::text)<=60000),
 PRIMARY KEY(workspace_id,request_id,record_kind,record_id),FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id)
);
GRANT SELECT,INSERT,DELETE ON crm_ask_admitted_sources,crm_ask_admitted_records TO app_runtime,migration;
CREATE FUNCTION guard_crm_ask_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent crm_ask_requests%ROWTYPE; total integer;
BEGIN
 SELECT * INTO parent FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF parent.state<>'pending' OR parent.execution_version<>'agent_v1' OR parent.cancelled_at IS NOT NULL OR parent.version<>NEW.request_version OR parent.epoch<>NEW.request_epoch THEN RAISE EXCEPTION 'Admission requires current pending request' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 IF TG_TABLE_NAME='crm_ask_admitted_sources' THEN
 SELECT count(*)+jsonb_array_length(parent.scope->'sources') INTO total FROM crm_ask_admitted_sources WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id;
 IF total>10 THEN RAISE EXCEPTION 'Source admission ceiling' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 ELSE
 SELECT count(*) INTO total FROM crm_ask_admitted_records WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id;
 IF total>100 THEN RAISE EXCEPTION 'Record admission ceiling' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_admitted_source_current AFTER INSERT ON crm_ask_admitted_sources DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_admission();
CREATE CONSTRAINT TRIGGER crm_ask_admitted_record_current AFTER INSERT ON crm_ask_admitted_records DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_admission();
CREATE OR REPLACE FUNCTION guard_crm_ask_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent crm_ask_requests%ROWTYPE; selected jsonb; position integer; admitted crm_ask_admitted_sources%ROWTYPE;
BEGIN
 SELECT * INTO parent FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF parent.state<>'pending' OR parent.version<>NEW.request_version OR parent.epoch<>NEW.request_epoch THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_window_current_request',MESSAGE='Ask window requires current private request'; END IF;
 SELECT src,ordinality::integer-1 INTO selected,position FROM jsonb_array_elements(parent.scope->'sources') WITH ORDINALITY AS sources(src,ordinality) WHERE src->>'kind'=NEW.source_kind AND src->>'sourceId'=NEW.source_id::text;
 IF selected IS NOT NULL AND selected->>'revision'=NEW.source_revision::text AND selected->>'contentHash'=NEW.source_hash AND parent.initial_contexts->position IS NOT DISTINCT FROM NEW.context_snapshot AND parent.initial_access_closure IS NOT DISTINCT FROM NEW.original_access_closure THEN RETURN NEW; END IF;
 SELECT * INTO admitted FROM crm_ask_admitted_sources WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id AND request_version=NEW.request_version AND request_epoch=NEW.request_epoch AND source_kind=NEW.source_kind AND source_id=NEW.source_id;
 IF NOT FOUND OR admitted.source_revision<>NEW.source_revision OR admitted.source_hash<>NEW.source_hash OR admitted.context_snapshot IS DISTINCT FROM NEW.context_snapshot OR admitted.original_access_closure IS DISTINCT FROM NEW.original_access_closure THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_window_current_request',MESSAGE='Ask window requires original or admitted authority'; END IF;
 RETURN NEW;
END $$;
ALTER TABLE crm_ask_requests ADD COLUMN clarification jsonb CHECK(clarification IS NULL OR jsonb_typeof(clarification)='object' AND octet_length(clarification::text)<=60000);
CREATE FUNCTION erase_crm_ask_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('stale','deleted') OR NEW.question IS NULL THEN
 DELETE FROM crm_ask_admitted_sources WHERE workspace_id=NEW.workspace_id AND request_id=NEW.id;
 DELETE FROM crm_ask_admitted_records WHERE workspace_id=NEW.workspace_id AND request_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erase_crm_ask_admission AFTER UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION erase_crm_ask_admission();
CREATE FUNCTION redact_crm_ask_clarification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('stale','deleted') OR NEW.question IS NULL THEN NEW.clarification:=NULL; END IF; RETURN NEW; END $$;
CREATE TRIGGER redact_crm_ask_clarification BEFORE UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION redact_crm_ask_clarification();
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_clarification_redacted CHECK(state NOT IN ('deleted','stale') OR clarification IS NULL);
CREATE FUNCTION invalidate_crm_ask_admitted_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_kind text; changed_id uuid;
BEGIN
 changed_kind:=CASE TG_TABLE_NAME WHEN 'crm_selected_sources' THEN 'selected_note' WHEN 'crm_mail_sources' THEN 'mail' WHEN 'call_transcripts' THEN 'call_transcript' ELSE 'meeting_transcript' END;
 changed_id:=CASE WHEN TG_TABLE_NAME='crm_mail_sources' THEN (to_jsonb(OLD)->>'source_id')::uuid WHEN TG_TABLE_NAME='call_transcripts' THEN (to_jsonb(OLD)->>'call_session_id')::uuid ELSE (to_jsonb(OLD)->>'id')::uuid END;
 IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
 UPDATE crm_ask_requests SET state='stale',reason='source_changed',question=NULL,result=NULL,result_at=NULL,validated_progress=NULL,version=version+1,epoch=epoch+1,updated_at=clock_timestamp() WHERE workspace_id=OLD.workspace_id AND state NOT IN ('stale','deleted') AND id IN(SELECT request_id FROM crm_ask_admitted_sources WHERE workspace_id=OLD.workspace_id AND source_id=changed_id AND source_kind=changed_kind);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_admitted_selected_changed AFTER UPDATE OR DELETE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_admitted_copy();
CREATE TRIGGER crm_ask_admitted_mail_changed AFTER UPDATE OR DELETE ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_admitted_copy();
CREATE TRIGGER crm_ask_admitted_call_changed AFTER UPDATE OR DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_admitted_copy();
CREATE TRIGGER crm_ask_admitted_meeting_changed AFTER UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_admitted_copy();

-- Opaque history lineage survives erasure; no source body or model prose is copied.
CREATE TABLE crm_ask_history_dependencies (
 workspace_id uuid NOT NULL,request_id uuid NOT NULL,parent_request_id uuid NOT NULL,parent_version integer NOT NULL CHECK(parent_version>0),parent_epoch integer NOT NULL CHECK(parent_epoch>0),
 PRIMARY KEY(workspace_id,request_id,parent_request_id),
 CONSTRAINT crm_ask_history_child_fkey FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id),CONSTRAINT crm_ask_history_parent_fkey FOREIGN KEY(workspace_id,parent_request_id) REFERENCES crm_ask_requests(workspace_id,id),
 CHECK(request_id<>parent_request_id)
);
GRANT SELECT,INSERT ON crm_ask_history_dependencies TO app_runtime,migration;
CREATE FUNCTION guard_crm_ask_history_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM crm_ask_requests c JOIN crm_ask_requests p ON p.workspace_id=c.workspace_id WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.request_id AND p.id=NEW.parent_request_id) AND NOT EXISTS(SELECT 1 FROM crm_ask_requests c JOIN crm_ask_requests p ON p.workspace_id=c.workspace_id AND p.owner_user_id=c.owner_user_id WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.request_id AND c.state='pending' AND c.cancelled_at IS NULL AND p.id=NEW.parent_request_id AND p.state='complete' AND p.question IS NOT NULL AND p.version=NEW.parent_version AND p.epoch=NEW.parent_epoch AND p.created_at<=c.created_at) THEN RAISE EXCEPTION 'History dependency requires current completed parent and pending owner-private child' USING ERRCODE='23514',CONSTRAINT='crm_ask_history_dependency_current'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_history_dependency_current AFTER INSERT ON crm_ask_history_dependencies DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_history_dependency();
CREATE FUNCTION invalidate_crm_ask_dependent_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('stale','deleted') OR NEW.question IS NULL THEN
 UPDATE crm_ask_requests SET state=CASE WHEN NEW.state='deleted' THEN 'deleted' ELSE 'stale' END,reason=CASE WHEN NEW.state='deleted' THEN 'deleted' ELSE 'source_changed' END,question=NULL,result=NULL,result_at=NULL,scope=CASE WHEN NEW.state='deleted' THEN NULL ELSE scope END,initial_contexts=CASE WHEN NEW.state='deleted' THEN NULL ELSE initial_contexts END,initial_access_closure=CASE WHEN NEW.state='deleted' THEN NULL ELSE initial_access_closure END,version=version+1,epoch=epoch+1,updated_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND state<>'deleted' AND (NEW.state='deleted' OR state<>'stale') AND id IN(SELECT request_id FROM crm_ask_history_dependencies WHERE workspace_id=NEW.workspace_id AND parent_request_id=NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_crm_ask_dependent_history AFTER UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_dependent_history();

-- Reviewed runtime limits/dimensions remain body-free, typed configuration; no authority is minted.
ALTER TABLE crm_capability_authority_receipts DROP CONSTRAINT crm_capability_authority_body_free;
ALTER TABLE crm_capability_authority_receipts ADD CONSTRAINT crm_capability_authority_body_free CHECK(
 jsonb_typeof(receipt->'configuration')='object' AND
 (receipt->'configuration')-ARRAY['capability','workspaceId','ownerUserId','revision','mailboxId','providerAccountId','generation','accountBinding','disclosureVersion','disclosureSha256','scopeDays','policyRevision','grantReceipt','providerPolicyReceipt','evaluationReceipt','releaseReceipt','captureVersion','scopeFingerprint','allocationFingerprint','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','dailyCeilingCents','monthlyCeilingCents','inputTokenPriceMicros','outputTokenPriceMicros','processorVersion','purpose','evaluationFingerprint','retrievalVersion','answerVersion','supportVersion','chunkerVersion','agentLimits','embeddingDimensions']='{}'::jsonb AND
 COALESCE((NOT (receipt->'configuration')?'agentLimits' OR capability='ask_answer' AND receipt->'configuration'->>'purpose'='answer' AND crm_ask_agent_limits_valid(receipt->'configuration'->'agentLimits')),false) AND
 COALESCE((NOT (receipt->'configuration')?'embeddingDimensions' OR capability='ask_answer' AND receipt->'configuration'->>'purpose'='embedding' AND jsonb_typeof(receipt->'configuration'->'embeddingDimensions')='number' AND (receipt->'configuration'->>'embeddingDimensions') IN ('256','512','1024')),false) AND
 jsonb_typeof(receipt->'proof')='object' AND
 (receipt->'proof')-ARRAY['evaluationKind','evaluationFingerprint','evaluationConfigurationFingerprint','evaluationReference','accessGrantReference','dataHandlingReference','providerAcceptanceReference','deletionAcceptanceReference','fundingReference','oauthGrantObservationId','release']='{}'::jsonb AND
 jsonb_typeof(receipt->'proof'->'release')='object' AND
 (receipt->'proof'->'release')-ARRAY['reference','implementationCommit','apiImageDigest','workerImageDigest','schemaVersion','nativeAcceptanceReference']='{}'::jsonb);
