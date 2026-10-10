-- changes: crm_extraction_purposes, crm_extraction_financial_receipts, crm_ask_purposes, crm_ask_financial_receipts
-- Exact microdollars per token, with at most six fractional decimal places.
-- No numeric typmod: PostgreSQL must reject excess precision, never round it.
-- Existing integer values, purpose revisions, financial identities and grants
-- are retained. This migration changes no enabled control or provider authority.
ALTER TABLE crm_extraction_purposes
 ALTER COLUMN input_token_price_micros TYPE numeric USING input_token_price_micros::numeric,
 ALTER COLUMN output_token_price_micros TYPE numeric USING output_token_price_micros::numeric,
 DROP CONSTRAINT crm_extraction_purposes_input_token_price_micros_check,
 DROP CONSTRAINT crm_extraction_purposes_output_token_price_micros_check,
 ADD CONSTRAINT crm_extraction_purposes_input_token_price_micros_check CHECK(input_token_price_micros>0 AND input_token_price_micros<=1000000 AND scale(input_token_price_micros)<=6),
 ADD CONSTRAINT crm_extraction_purposes_output_token_price_micros_check CHECK(output_token_price_micros>=0 AND output_token_price_micros<=1000000 AND scale(output_token_price_micros)<=6);

ALTER TABLE crm_extraction_financial_receipts
 ALTER COLUMN input_price_micros TYPE numeric USING input_price_micros::numeric,
 ALTER COLUMN output_price_micros TYPE numeric USING output_price_micros::numeric,
 DROP CONSTRAINT crm_financial_input_price_bounded,
 DROP CONSTRAINT crm_financial_output_price_bounded,
 ADD CONSTRAINT crm_financial_input_price_bounded CHECK(input_price_micros>0 AND input_price_micros<=1000000 AND scale(input_price_micros)<=6),
 ADD CONSTRAINT crm_financial_output_price_bounded CHECK(output_price_micros>=0 AND output_price_micros<=1000000 AND scale(output_price_micros)<=6);

ALTER TABLE crm_ask_purposes
 ALTER COLUMN input_token_price_micros TYPE numeric USING input_token_price_micros::numeric,
 ALTER COLUMN output_token_price_micros TYPE numeric USING output_token_price_micros::numeric,
 DROP CONSTRAINT crm_ask_purposes_input_token_price_micros_check,
 DROP CONSTRAINT crm_ask_purposes_output_token_price_micros_check,
 ADD CONSTRAINT crm_ask_purposes_input_token_price_micros_check CHECK(input_token_price_micros>0 AND input_token_price_micros<=1000000 AND scale(input_token_price_micros)<=6),
 ADD CONSTRAINT crm_ask_purposes_output_token_price_micros_check CHECK(output_token_price_micros>=0 AND output_token_price_micros<=1000000 AND scale(output_token_price_micros)<=6);

ALTER TABLE crm_ask_financial_receipts
 ALTER COLUMN input_price_micros TYPE numeric USING input_price_micros::numeric,
 ALTER COLUMN output_price_micros TYPE numeric USING output_price_micros::numeric,
 DROP CONSTRAINT crm_ask_financial_receipts_input_price_micros_check,
 DROP CONSTRAINT crm_ask_financial_receipts_output_price_micros_check,
 ADD CONSTRAINT crm_ask_financial_receipts_input_price_micros_check CHECK(input_price_micros>0 AND input_price_micros<=1000000 AND scale(input_price_micros)<=6),
 ADD CONSTRAINT crm_ask_financial_receipts_output_price_micros_check CHECK(output_price_micros>=0 AND output_price_micros<=1000000 AND scale(output_price_micros)<=6);

-- Preserve legacy numeric JSON snapshots; new fractions use canonical strings.
CREATE OR REPLACE FUNCTION crm_ask_purpose_snapshot_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; cap numeric;
BEGIN
 IF value IS NULL OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR value-ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents']<>'{}'::jsonb OR NOT value ?& ARRAY['purpose','revision','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','evaluationFingerprint','processorVersion','retrievalVersion','answerVersion','supportVersion','chunkerVersion','inputTokenPriceMicros','outputTokenPriceMicros','dailyCeilingCents','monthlyCeilingCents'] THEN RETURN false; END IF;
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
 RETURN true;
END;
$$;
