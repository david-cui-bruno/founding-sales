-- changes: provider_reservations
CREATE FUNCTION crm_ask_input_valid(ws uuid,selected_scope jsonb,contexts jsonb,closure jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE src jsonb; cx jsonb; identities text[]:='{}'; identity text;
BEGIN
 IF selected_scope IS NULL OR contexts IS NULL OR closure IS NULL OR jsonb_typeof(selected_scope) IS DISTINCT FROM 'object' OR selected_scope-ARRAY['sources']<>'{}'::jsonb OR jsonb_typeof(selected_scope->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(contexts) IS DISTINCT FROM 'array' OR NOT COALESCE(crm_access_closure_valid(closure),false) THEN RETURN false; END IF;
 IF jsonb_array_length(selected_scope->'sources') NOT BETWEEN 1 AND 10 OR jsonb_array_length(contexts)<>jsonb_array_length(selected_scope->'sources') THEN RETURN false; END IF;
 FOR src IN SELECT jsonb_array_elements(selected_scope->'sources') LOOP
  IF jsonb_typeof(src) IS DISTINCT FROM 'object' OR NOT src ?& ARRAY['workspaceId','sourceId','kind','revision','contentHash','locator'] OR src-ARRAY['workspaceId','sourceId','kind','revision','contentHash','locator']<>'{}'::jsonb
  OR src->>'workspaceId' IS DISTINCT FROM ws::text OR src->>'sourceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR jsonb_typeof(src->'sourceId') IS DISTINCT FROM 'string' OR src->>'kind' NOT IN ('selected_note','mail','call_transcript','meeting_transcript') OR jsonb_typeof(src->'kind') IS DISTINCT FROM 'string'
  OR jsonb_typeof(src->'revision') IS DISTINCT FROM 'number' OR src->>'revision' !~ '^[1-9][0-9]*$' OR (src->>'revision')::numeric>2147483647
  OR jsonb_typeof(src->'contentHash') IS DISTINCT FROM 'string' OR src->>'contentHash' !~ '^[a-f0-9]{64}$' OR src->'locator' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  identity:=concat(src->>'kind',':',src->>'sourceId');
  IF identity=ANY(identities) THEN RETURN false; END IF;
  identities:=array_append(identities,identity);
 END LOOP;
 FOR cx IN SELECT jsonb_array_elements(contexts) LOOP
  IF jsonb_typeof(cx) IS DISTINCT FROM 'object' OR NOT COALESCE(crm_extraction_context_valid(cx),false) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
-- Owner-private requests are also the future private history identity.
CREATE TABLE crm_ask_requests (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 epoch integer NOT NULL DEFAULT 1 CHECK(epoch>0),
 question text,
 scope jsonb,
 initial_contexts jsonb,
 initial_access_closure jsonb,
 state text NOT NULL CHECK(state IN ('pending','unavailable','unknown_acceptance','stale','complete','deleted')),
 reason text CHECK(reason IS NULL OR reason IN ('purpose_unavailable','evaluation_unavailable','processing_authority_unavailable','budget_held','input_bound_reached','source_unavailable','source_changed','purpose_changed','provider_acceptance_unknown','processing_failed','unsupported_answer','deleted')),
 result jsonb,
 result_at timestamptz,
 purpose_revision integer CHECK(purpose_revision IS NULL OR purpose_revision>0),
 evaluation_fingerprint text CHECK(evaluation_fingerprint IS NULL OR evaluation_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_ask_request_private_shape CHECK (
  (state='deleted' AND question IS NULL AND scope IS NULL AND initial_contexts IS NULL AND initial_access_closure IS NULL AND result IS NULL AND result_at IS NULL)
  OR (state<>'deleted' AND crm_ask_input_valid(workspace_id,scope,initial_contexts,initial_access_closure) AND (question IS NOT NULL AND length(question) BETWEEN 1 AND 300 OR state='stale' AND question IS NULL))),
 CONSTRAINT crm_ask_request_result_shape CHECK ((state='complete' AND result IS NOT NULL AND jsonb_typeof(result)='object' AND octet_length(result::text)<=100000 AND result_at IS NOT NULL) OR (state<>'complete' AND result IS NULL AND result_at IS NULL))
);
CREATE FUNCTION crm_ask_initial_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at)
 OR OLD.state='deleted' AND NEW.state<>'deleted'
 OR OLD.state='stale' AND NEW.state NOT IN ('stale','deleted')
 OR NEW.version<OLD.version OR NEW.epoch<OLD.epoch
 OR NEW.question IS DISTINCT FROM OLD.question AND NOT (OLD.question IS NOT NULL AND NEW.question IS NULL AND NEW.state IN ('stale','deleted'))
 OR NEW.state<>'deleted' AND ROW(NEW.scope,NEW.initial_contexts,NEW.initial_access_closure) IS DISTINCT FROM ROW(OLD.scope,OLD.initial_contexts,OLD.initial_access_closure) THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_initial_identity_immutable',MESSAGE='Ask initial identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER crm_ask_initial_identity_immutable AFTER UPDATE ON crm_ask_requests DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_initial_identity_immutable();
CREATE TABLE crm_ask_purposes (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 purpose text NOT NULL CHECK(purpose IN ('answer','embedding','support')),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 endpoint_id text NOT NULL CHECK(length(endpoint_id) BETWEEN 1 AND 100),
 model_version text NOT NULL CHECK(length(model_version) BETWEEN 1 AND 200),
 access_grant_version text NOT NULL CHECK(length(access_grant_version) BETWEEN 1 AND 200),
 data_handling_version text NOT NULL CHECK(length(data_handling_version) BETWEEN 1 AND 200),
 evaluation_fingerprint text NOT NULL CHECK(evaluation_fingerprint ~ '^[a-f0-9]{64}$'),
 processor_version text NOT NULL CHECK(length(processor_version) BETWEEN 1 AND 100),
 retrieval_version text NOT NULL CHECK(length(retrieval_version) BETWEEN 1 AND 100),
 answer_version text NOT NULL CHECK(length(answer_version) BETWEEN 1 AND 100),
 support_version text NOT NULL CHECK(length(support_version) BETWEEN 1 AND 100),
 chunker_version text NOT NULL CHECK(length(chunker_version) BETWEEN 1 AND 100),
 daily_ceiling_cents integer NOT NULL CHECK(daily_ceiling_cents BETWEEN 1 AND 100000),
 monthly_ceiling_cents integer NOT NULL CHECK(monthly_ceiling_cents BETWEEN 1 AND 1000000),
 input_token_price_micros integer NOT NULL CHECK(input_token_price_micros BETWEEN 1 AND 1000000),
 output_token_price_micros integer NOT NULL CHECK(output_token_price_micros BETWEEN 1 AND 1000000),
 approved_by uuid NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,purpose),
 FOREIGN KEY(workspace_id,approved_by) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE ON crm_ask_requests TO app_runtime,migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_ask_purposes TO app_runtime,migration;
CREATE TABLE crm_ask_request_windows (
 workspace_id uuid NOT NULL,
 request_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_version integer NOT NULL CHECK(request_version>0),
 request_epoch integer NOT NULL CHECK(request_epoch>0),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 locator text NOT NULL CHECK(length(locator) BETWEEN 1 AND 200),
 parser_version text NOT NULL DEFAULT 'canonical-original-v1' CHECK(length(parser_version) BETWEEN 1 AND 100),
 chunker_version text NOT NULL DEFAULT 'lexical-original-v1' CHECK(length(chunker_version) BETWEEN 1 AND 100),
 context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
 text_hash text NOT NULL CHECK(text_hash ~ '^[a-f0-9]{64}$'),
 group_hash text NOT NULL CHECK(group_hash ~ '^[a-f0-9]{64}$'),
 context_snapshot jsonb NOT NULL CHECK(crm_extraction_context_valid(context_snapshot)),
 original_access_closure jsonb NOT NULL CHECK(crm_access_closure_valid(original_access_closure)),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id),
 UNIQUE(workspace_id,request_id,request_version,request_epoch,ordinal)
);
GRANT SELECT,INSERT,DELETE ON crm_ask_request_windows TO app_runtime,migration;
CREATE FUNCTION crm_ask_purpose_snapshot_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; cap numeric;
BEGIN
 IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents']<>'{}'::jsonb OR NOT value ?& ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents'] THEN RETURN false; END IF;
 IF jsonb_typeof(value->'purpose') IS DISTINCT FROM 'string' OR value->>'purpose' NOT IN ('answer','embedding','support') OR jsonb_typeof(value->'evaluationFingerprint') IS DISTINCT FROM 'string' OR value->>'evaluationFingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion'] LOOP
  IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR length(value->>key) NOT BETWEEN 1 AND (CASE WHEN key IN ('modelVersion','accessGrantVersion','dataHandlingVersion') THEN 200 ELSE 100 END) THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['revision','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents'] LOOP
  cap:=CASE WHEN key='revision' THEN 2147483647 WHEN key='dailyCeilingCents' THEN 100000 ELSE 1000000 END;
  IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR value->>key !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
  IF (value->>key)::numeric>cap THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE crm_ask_financial_receipts (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_id uuid NOT NULL,
 request_version integer NOT NULL CHECK(request_version>0),
 request_epoch integer NOT NULL CHECK(request_epoch>0),
 stage text NOT NULL CHECK(stage IN ('answer','embedding_query','embedding_document','support')),
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 reservation_id uuid NOT NULL,
 job_id uuid NOT NULL,
 fencing_token bigint NOT NULL CHECK(fencing_token>0),
 purpose_revision integer NOT NULL CHECK(purpose_revision>0),
 purpose_snapshot jsonb NOT NULL,
 config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 evaluation_fingerprint text NOT NULL CHECK(evaluation_fingerprint ~ '^[a-f0-9]{64}$'),
 authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 input_price_micros integer NOT NULL CHECK(input_price_micros BETWEEN 1 AND 1000000),
 output_price_micros integer NOT NULL CHECK(output_price_micros BETWEEN 1 AND 1000000),
 max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 1000000),
 max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 100000),
 dispatch_state text NOT NULL CHECK(dispatch_state IN ('reserved','calling','unknown_acceptance','settled','released')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id),
 FOREIGN KEY(workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id),
 CONSTRAINT crm_ask_financial_purpose_shape CHECK(crm_ask_purpose_snapshot_valid(purpose_snapshot)),
 CONSTRAINT crm_ask_financial_attempt UNIQUE(workspace_id,request_id,request_version,request_epoch,stage,attempt),
 CONSTRAINT crm_ask_financial_reservation UNIQUE(workspace_id,reservation_id)
);
GRANT SELECT,INSERT,UPDATE ON crm_ask_financial_receipts TO app_runtime,migration;

ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support')),
 DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));

-- A selected copy deletion erases the entire private question and answer.
CREATE FUNCTION invalidate_crm_ask_selected_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erased boolean;
BEGIN
 IF TG_OP='DELETE' OR OLD.availability IS DISTINCT FROM NEW.availability OR OLD.revision IS DISTINCT FROM NEW.revision OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
  erased:=TG_OP='DELETE' OR NEW.availability='deleted';
  DELETE FROM crm_ask_request_windows w USING crm_ask_requests a WHERE w.workspace_id=a.workspace_id AND w.request_id=a.id AND a.workspace_id=OLD.workspace_id AND a.state<>'deleted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.scope->'sources') src WHERE src->>'kind'='selected_note' AND src->>'sourceId'=OLD.id::text);
  UPDATE crm_ask_requests a SET question=NULL,result=NULL,result_at=NULL,scope=CASE WHEN erased THEN NULL ELSE scope END,initial_contexts=CASE WHEN erased THEN NULL ELSE initial_contexts END,initial_access_closure=CASE WHEN erased THEN NULL ELSE initial_access_closure END,state=CASE WHEN erased THEN 'deleted' ELSE 'stale' END,reason=CASE WHEN erased THEN 'deleted' ELSE 'source_changed' END,version=version+1,epoch=epoch+1,updated_at=now() WHERE a.workspace_id=OLD.workspace_id AND a.state<>'deleted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.scope->'sources') src WHERE src->>'kind'='selected_note' AND src->>'sourceId'=OLD.id::text);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_ask_selected_invalidation AFTER UPDATE OR DELETE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_selected_copy();

CREATE FUNCTION invalidate_crm_ask_mail_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE erased boolean;
BEGIN
 IF TG_OP='DELETE' OR OLD.availability IS DISTINCT FROM NEW.availability OR OLD.source_revision IS DISTINCT FROM NEW.source_revision OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
  erased:=TG_OP='DELETE' OR NEW.availability='deleted';
  DELETE FROM crm_ask_request_windows w USING crm_ask_requests a WHERE w.workspace_id=a.workspace_id AND w.request_id=a.id AND a.workspace_id=OLD.workspace_id AND a.state<>'deleted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.scope->'sources') src WHERE src->>'kind'='mail' AND src->>'sourceId'=OLD.source_id::text);
  UPDATE crm_ask_requests a SET question=NULL,result=NULL,result_at=NULL,scope=CASE WHEN erased THEN NULL ELSE scope END,initial_contexts=CASE WHEN erased THEN NULL ELSE initial_contexts END,initial_access_closure=CASE WHEN erased THEN NULL ELSE initial_access_closure END,state=CASE WHEN erased THEN 'deleted' ELSE 'stale' END,reason=CASE WHEN erased THEN 'deleted' ELSE 'source_changed' END,version=version+1,epoch=epoch+1,updated_at=now() WHERE a.workspace_id=OLD.workspace_id AND a.state<>'deleted' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.scope->'sources') src WHERE src->>'kind'='mail' AND src->>'sourceId'=OLD.source_id::text);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_ask_mail_invalidation AFTER UPDATE OR DELETE ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_mail_copy();

CREATE FUNCTION guard_crm_ask_window() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent crm_ask_requests%ROWTYPE; selected jsonb; position integer;
BEGIN
 SELECT * INTO parent FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF; -- The workspace-bound FK reports a missing parent.
 IF parent.state<>'pending' OR parent.version<>NEW.request_version OR parent.epoch<>NEW.request_epoch THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_window_current_request',MESSAGE='Ask window requires current private request';
 END IF;
 SELECT src,ordinality::integer-1 INTO selected,position FROM jsonb_array_elements(parent.scope->'sources') WITH ORDINALITY AS sources(src,ordinality) WHERE src->>'kind'=NEW.source_kind AND src->>'sourceId'=NEW.source_id::text;
 IF selected IS NULL OR selected->>'revision'<>NEW.source_revision::text OR selected->>'contentHash'<>NEW.source_hash OR parent.initial_contexts->position IS DISTINCT FROM NEW.context_snapshot OR parent.initial_access_closure IS DISTINCT FROM NEW.original_access_closure THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_window_current_request',MESSAGE='Ask window requires original input authority';
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION lock_crm_ask_window_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR UPDATE;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_ask_window_parent_lock BEFORE INSERT ON crm_ask_request_windows FOR EACH ROW EXECUTE FUNCTION lock_crm_ask_window_parent();
CREATE CONSTRAINT TRIGGER crm_ask_window_current_request AFTER INSERT ON crm_ask_request_windows DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_window();

CREATE FUNCTION guard_crm_ask_financial_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'dispatch_state') IS DISTINCT FROM (to_jsonb(OLD)-'dispatch_state')
 OR NEW.dispatch_state<>OLD.dispatch_state AND NOT (OLD.dispatch_state='reserved' AND NEW.dispatch_state IN ('calling','released') OR OLD.dispatch_state='calling' AND NEW.dispatch_state IN ('settled','unknown_acceptance')) THEN
  RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_financial_immutable',MESSAGE='Ask priced financial proof is immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER crm_ask_financial_immutable AFTER UPDATE ON crm_ask_financial_receipts DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_financial_immutable();
