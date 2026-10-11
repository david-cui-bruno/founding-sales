-- changes: crm_ask_requests, crm_ask_purposes, crm_ask_financial_receipts
ALTER TABLE crm_ask_requests ADD COLUMN execution_version text NOT NULL DEFAULT 'legacy_v1' CHECK(execution_version IN ('legacy_v1','agent_v1'));
ALTER TABLE crm_ask_requests ADD COLUMN cancelled_at timestamptz;
ALTER TABLE crm_ask_requests ADD COLUMN completed_steps integer NOT NULL DEFAULT 0 CHECK(completed_steps BETWEEN 0 AND 32);
ALTER TABLE crm_ask_requests ADD COLUMN progress_stage text NOT NULL DEFAULT 'queued' CHECK(progress_stage IN ('queued','reading','calling','validating','complete','cancelled','unavailable'));
-- Receipt attempt is the monotonically admitted provider step. Existing attempt-one receipts remain unchanged.

-- changes: provider_reservations
CREATE OR REPLACE FUNCTION crm_ask_input_valid(ws uuid,selected_scope jsonb,contexts jsonb,closure jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE src jsonb; cx jsonb; identities text[]:='{}'; identity text;
BEGIN
 IF selected_scope IS NULL OR contexts IS NULL OR closure IS NULL OR jsonb_typeof(selected_scope) IS DISTINCT FROM 'object' OR selected_scope-ARRAY['sources']<>'{}'::jsonb OR jsonb_typeof(selected_scope->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(contexts) IS DISTINCT FROM 'array' OR NOT COALESCE(crm_access_closure_valid(closure),false) THEN RETURN false; END IF;
 IF jsonb_array_length(selected_scope->'sources') NOT BETWEEN 0 AND 10 OR jsonb_array_length(contexts)<>jsonb_array_length(selected_scope->'sources') THEN RETURN false; END IF;
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

ALTER TABLE crm_ask_requests DROP CONSTRAINT crm_ask_request_private_shape;
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_request_private_shape CHECK (
 (state='deleted' AND question IS NULL AND scope IS NULL AND initial_contexts IS NULL AND initial_access_closure IS NULL AND result IS NULL AND result_at IS NULL)
 OR (state<>'deleted' AND crm_ask_input_valid(workspace_id,scope,initial_contexts,initial_access_closure) AND (execution_version='agent_v1' OR jsonb_array_length(scope->'sources')>0) AND (question IS NOT NULL AND length(question) BETWEEN 1 AND 300 OR state='stale' AND question IS NULL)));
ALTER TABLE crm_ask_requests DROP CONSTRAINT crm_ask_requests_reason_check;
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_requests_reason_check CHECK(reason IS NULL OR reason IN ('purpose_unavailable','evaluation_unavailable','processing_authority_unavailable','budget_held','input_bound_reached','source_unavailable','source_changed','purpose_changed','provider_acceptance_unknown','processing_failed','unsupported_answer','identity_clarification_required','deleted'));
ALTER TABLE crm_ask_financial_receipts DROP CONSTRAINT crm_ask_financial_receipts_attempt_check;
ALTER TABLE crm_ask_financial_receipts ADD CONSTRAINT crm_ask_financial_receipts_attempt_check CHECK(attempt BETWEEN 1 AND 32);
ALTER TABLE crm_ask_purposes ADD COLUMN agent_limits jsonb;
CREATE FUNCTION crm_ask_agent_limits_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce((
 jsonb_typeof(value)='object' AND value ?& ARRAY['maxSteps','maxInputBytes','maxOutputTokens','deadlineMs'] AND value-ARRAY['maxSteps','maxInputBytes','maxOutputTokens','deadlineMs']='{}'::jsonb
 AND jsonb_typeof(value->'maxSteps')='number' AND value->>'maxSteps' ~ '^[1-9][0-9]*$' AND (value->>'maxSteps')::numeric BETWEEN 1 AND 32
 AND jsonb_typeof(value->'maxInputBytes')='number' AND value->>'maxInputBytes' ~ '^[1-9][0-9]*$' AND (value->>'maxInputBytes')::numeric BETWEEN 1 AND 1000000
 AND jsonb_typeof(value->'maxOutputTokens')='number' AND value->>'maxOutputTokens' ~ '^[1-9][0-9]*$' AND (value->>'maxOutputTokens')::numeric BETWEEN 1 AND 4096
 AND jsonb_typeof(value->'deadlineMs')='number' AND value->>'deadlineMs' ~ '^[1-9][0-9]*$' AND (value->>'deadlineMs')::numeric BETWEEN 1 AND 60000),false) $$;
ALTER TABLE crm_ask_purposes ADD CONSTRAINT crm_ask_agent_limits_valid CHECK(agent_limits IS NULL OR crm_ask_agent_limits_valid(agent_limits));

CREATE OR REPLACE FUNCTION crm_ask_purpose_snapshot_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; cap numeric;
BEGIN
 IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['agentLimits','purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents']<>'{}'::jsonb OR NOT value ?& ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents'] THEN RETURN false; END IF;
 IF jsonb_typeof(value->'purpose') IS DISTINCT FROM 'string' OR value->>'purpose' NOT IN ('answer','embedding','support') OR jsonb_typeof(value->'evaluationFingerprint') IS DISTINCT FROM 'string' OR value->>'evaluationFingerprint' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion'] LOOP
  IF jsonb_typeof(value->key) IS DISTINCT FROM 'string' OR length(value->>key) NOT BETWEEN 1 AND (CASE WHEN key IN ('modelVersion','accessGrantVersion','dataHandlingVersion') THEN 200 ELSE 100 END) THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['revision','dailyCeilingCents','monthlyCeilingCents'] LOOP
  cap:=CASE WHEN key='revision' THEN 2147483647 WHEN key='dailyCeilingCents' THEN 100000 ELSE 1000000 END;
  IF jsonb_typeof(value->key) IS DISTINCT FROM 'number' OR value->>key !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
  IF (value->>key)::numeric>cap THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['inputTokenPriceMicros','outputTokenPriceMicros'] LOOP
  IF jsonb_typeof(value->key)='number' THEN
   IF value->>key !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  ELSIF jsonb_typeof(value->key)='string' THEN
   IF value->>key !~ '^(0|[1-9][0-9]{0,6})[.][0-9]{0,5}[1-9]$' THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
  IF (value->>key)::numeric>1000000 OR (value->>key)::numeric<0 OR key='inputTokenPriceMicros' AND (value->>key)::numeric=0 THEN RETURN false; END IF;
 END LOOP;
 IF value ? 'agentLimits' AND NOT crm_ask_agent_limits_valid(value->'agentLimits') THEN RETURN false; END IF;
 RETURN true;
END;
$$;
