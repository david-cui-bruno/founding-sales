-- changes: sourcing_manual_prospect_states
-- Only source IDs, hashes and spans survive. Phone prose is derived during authorized reads.
ALTER TABLE sourcing_manual_prospect_states ADD COLUMN manual_phone_choice jsonb;
ALTER TABLE sourcing_manual_prospect_states ADD CONSTRAINT manual_prospect_phone_choice_shape CHECK (
 manual_phone_choice IS NULL OR (state='kept' AND jsonb_typeof(manual_phone_choice)='object'
 AND manual_phone_choice ?& ARRAY['runId','observationId','blockId','labelStart','labelEnd','start','end','contentHash','relevantTextHash']
 AND manual_phone_choice - ARRAY['runId','observationId','blockId','labelStart','labelEnd','start','end','contentHash','relevantTextHash']='{}'::jsonb
 AND jsonb_typeof(manual_phone_choice->'runId')='string' AND manual_phone_choice->>'runId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
 AND jsonb_typeof(manual_phone_choice->'observationId')='string' AND manual_phone_choice->>'observationId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
 AND jsonb_typeof(manual_phone_choice->'blockId')='string' AND length(manual_phone_choice->>'blockId') BETWEEN 1 AND 80
 AND jsonb_typeof(manual_phone_choice->'contentHash')='string' AND manual_phone_choice->>'contentHash' ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(manual_phone_choice->'relevantTextHash')='string' AND manual_phone_choice->>'relevantTextHash' ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(manual_phone_choice->'labelStart')='number' AND manual_phone_choice->>'labelStart' ~ '^[0-9]{1,5}$'
 AND jsonb_typeof(manual_phone_choice->'labelEnd')='number' AND manual_phone_choice->>'labelEnd' ~ '^[0-9]{1,5}$'
 AND jsonb_typeof(manual_phone_choice->'start')='number' AND manual_phone_choice->>'start' ~ '^[0-9]{1,5}$'
 AND jsonb_typeof(manual_phone_choice->'end')='number' AND manual_phone_choice->>'end' ~ '^[0-9]{1,5}$'
 AND (manual_phone_choice->>'labelStart')::numeric BETWEEN 0 AND 16000
 AND (manual_phone_choice->>'labelEnd')::numeric BETWEEN (manual_phone_choice->>'labelStart')::numeric+1 AND LEAST((manual_phone_choice->>'labelStart')::numeric+200,16000)
 AND (manual_phone_choice->>'start')::numeric BETWEEN (manual_phone_choice->>'labelEnd')::numeric AND 16000
 AND (manual_phone_choice->>'end')::numeric BETWEEN (manual_phone_choice->>'start')::numeric+1 AND LEAST((manual_phone_choice->>'start')::numeric+200,16000)
 ) IS TRUE
);
