-- changes: outreach_answer_block_versions
-- Version-bound owner-sanitized factual scope, not a second fact library.
ALTER TABLE outreach_answer_block_versions ADD COLUMN social_input jsonb
 CHECK(social_input IS NULL OR (jsonb_typeof(social_input)='object' AND octet_length(social_input::text)<=4096));
