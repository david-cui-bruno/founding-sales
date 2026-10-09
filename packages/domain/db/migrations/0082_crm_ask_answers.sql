-- changes: provider_reservations
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
  OR (state<>'deleted' AND scope IS NOT NULL AND jsonb_typeof(scope)='object' AND jsonb_typeof(scope->'sources')='array' AND jsonb_array_length(scope->'sources') BETWEEN 1 AND 10 AND initial_contexts IS NOT NULL AND jsonb_typeof(initial_contexts)='array' AND crm_access_closure_valid(initial_access_closure) AND (question IS NOT NULL AND length(question) BETWEEN 1 AND 300 OR state='stale' AND question IS NULL))),
 CONSTRAINT crm_ask_request_result_shape CHECK ((state='complete' AND result IS NOT NULL AND jsonb_typeof(result)='object' AND octet_length(result::text)<=100000 AND result_at IS NOT NULL) OR (state<>'complete' AND result IS NULL AND result_at IS NULL))
);
CREATE FUNCTION crm_ask_initial_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at)
 OR OLD.state='deleted' AND NEW.state<>'deleted'
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
 purpose_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(purpose_snapshot)='object'),
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
