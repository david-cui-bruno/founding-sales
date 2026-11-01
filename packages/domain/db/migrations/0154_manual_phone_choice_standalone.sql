-- changes: sourcing_manual_prospect_states
-- ADR0034 follow-up. A standalone published number has no separate label, so its own span is the label:
-- the stored choice may now also have labelStart=start and labelEnd=end. Every shape previously accepted
-- (start>=labelEnd) is still accepted; nothing is rewritten and no stricter rule is added.
ALTER TABLE sourcing_manual_prospect_states DROP CONSTRAINT manual_prospect_phone_choice_shape;
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
 AND (manual_phone_choice->>'start')::numeric BETWEEN 0 AND 16000
 AND ((manual_phone_choice->>'start')::numeric>=(manual_phone_choice->>'labelEnd')::numeric
  OR ((manual_phone_choice->>'start')::numeric=(manual_phone_choice->>'labelStart')::numeric
   AND (manual_phone_choice->>'end')::numeric=(manual_phone_choice->>'labelEnd')::numeric))
 AND (manual_phone_choice->>'end')::numeric BETWEEN (manual_phone_choice->>'start')::numeric+1 AND LEAST((manual_phone_choice->>'start')::numeric+200,16000)
 ) IS TRUE
);
