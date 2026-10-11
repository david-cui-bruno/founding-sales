-- changes: crm_ask_window_vectors, crm_ask_purposes, crm_ask_financial_receipts
CREATE TABLE crm_ask_window_vectors(
 workspace_id uuid NOT NULL,
 window_id uuid NOT NULL,
 purpose_revision integer NOT NULL CHECK(purpose_revision>0),
 model_version text NOT NULL CHECK(length(model_version) BETWEEN 1 AND 200),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 dimensions integer NOT NULL CHECK(dimensions IN (256,512,1024)),
 vector double precision[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,window_id,purpose_revision,model_version),
 FOREIGN KEY(workspace_id,window_id) REFERENCES crm_ask_request_windows(workspace_id,id) ON DELETE CASCADE,
 CHECK(coalesce(array_length(vector,1)=dimensions,false) AND array_position(vector,NULL) IS NULL AND NOT vector && ARRAY['Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision])
);
GRANT SELECT,INSERT,DELETE ON crm_ask_window_vectors TO app_runtime,migration;

ALTER TABLE crm_ask_purposes ADD COLUMN embedding_dimensions integer CHECK(embedding_dimensions IS NULL OR embedding_dimensions IN (256,512,1024));

CREATE OR REPLACE FUNCTION crm_ask_purpose_snapshot_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; cap numeric;
BEGIN
 IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['embeddingDimensions','agentLimits','purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents']<>'{}'::jsonb OR NOT value ?& ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents'] THEN RETURN false; END IF;
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
 IF value ? 'embeddingDimensions' AND (jsonb_typeof(value->'embeddingDimensions') IS DISTINCT FROM 'number' OR value->>'embeddingDimensions' NOT IN ('256','512','1024')) THEN RETURN false; END IF;
 RETURN true;
END;
$$;
