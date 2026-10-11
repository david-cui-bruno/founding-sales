-- changes: crm_ask_requests
ALTER TABLE crm_ask_requests ADD COLUMN original_agent_scope jsonb;
ALTER TABLE crm_ask_requests ADD COLUMN validated_progress jsonb CONSTRAINT crm_ask_validated_progress_bound CHECK(validated_progress IS NULL OR coalesce((jsonb_typeof(validated_progress)='object' AND validated_progress-ARRAY['exactResults']='{}'::jsonb AND CASE WHEN jsonb_typeof(validated_progress->'exactResults')='array' THEN jsonb_array_length(validated_progress->'exactResults')<=20 ELSE false END AND octet_length(validated_progress::text)<=60000),false));
ALTER TABLE crm_ask_requests DROP CONSTRAINT crm_ask_requests_reason_check;
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_requests_reason_check CHECK(reason IS NULL OR reason IN ('purpose_unavailable','evaluation_unavailable','processing_authority_unavailable','budget_held','input_bound_reached','source_unavailable','source_changed','purpose_changed','provider_acceptance_unknown','processing_failed','unsupported_answer','identity_clarification_required','deleted','processing_cancelled'));
CREATE FUNCTION crm_ask_clear_agent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('deleted','stale') OR NEW.question IS NULL THEN NEW.original_agent_scope:=NULL; NEW.validated_progress:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_clear_agent_scope BEFORE UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION crm_ask_clear_agent_scope();
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_agent_scope_redacted CHECK(state NOT IN ('deleted','stale') OR original_agent_scope IS NULL);

ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_validated_progress_redacted CHECK((state NOT IN ('deleted','stale') AND question IS NOT NULL) OR validated_progress IS NULL);

-- Intent and execution are immutable inputs, distinct from complete source access.
CREATE OR REPLACE FUNCTION crm_ask_initial_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at)
 OR OLD.state='deleted' AND NEW.state<>'deleted'
 OR OLD.state='stale' AND NEW.state NOT IN ('stale','deleted')
 OR NEW.version<OLD.version OR NEW.epoch<OLD.epoch
 OR NEW.execution_version IS DISTINCT FROM OLD.execution_version
 OR NEW.original_agent_scope IS DISTINCT FROM OLD.original_agent_scope AND NOT(NEW.original_agent_scope IS NULL AND NEW.state IN ('stale','deleted'))
 OR NEW.question IS DISTINCT FROM OLD.question AND NOT (OLD.question IS NOT NULL AND NEW.question IS NULL AND NEW.state IN ('stale','deleted'))
 OR NEW.state<>'deleted' AND ROW(NEW.scope,NEW.initial_contexts,NEW.initial_access_closure) IS DISTINCT FROM ROW(OLD.scope,OLD.initial_contexts,OLD.initial_access_closure) THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_initial_identity_immutable',MESSAGE='Ask initial identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_agent_scope_shape CHECK(original_agent_scope IS NULL OR COALESCE(
 jsonb_typeof(original_agent_scope)='object'
 AND (NOT original_agent_scope?'from' OR jsonb_typeof(original_agent_scope->'from')='string' AND length(original_agent_scope->>'from') BETWEEN 20 AND 40)
 AND (NOT original_agent_scope?'to' OR jsonb_typeof(original_agent_scope->'to')='string' AND length(original_agent_scope->>'to') BETWEEN 20 AND 40)
 AND CASE original_agent_scope->>'kind'
 WHEN 'business' THEN original_agent_scope-ARRAY['kind','from','to']='{}'::jsonb
 WHEN 'firm' THEN original_agent_scope-ARRAY['kind','firmId','from','to']='{}'::jsonb AND jsonb_typeof(original_agent_scope->'firmId')='string' AND original_agent_scope->>'firmId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 WHEN 'person' THEN original_agent_scope-ARRAY['kind','personId','from','to']='{}'::jsonb AND jsonb_typeof(original_agent_scope->'personId')='string' AND original_agent_scope->>'personId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 WHEN 'selected' THEN original_agent_scope-ARRAY['kind','sources','from','to']='{}'::jsonb AND CASE WHEN jsonb_typeof(original_agent_scope->'sources')='array' THEN jsonb_array_length(original_agent_scope->'sources') BETWEEN 1 AND 10 ELSE false END
 ELSE false END,false));
