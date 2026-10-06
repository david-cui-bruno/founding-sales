-- changes: provider_reservations
CREATE TABLE social_draft_requests (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 source_selection jsonb NOT NULL CHECK(jsonb_typeof(source_selection)='object' AND octet_length(source_selection::text)<=8192),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 prompt_version text NOT NULL,
 model_name text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','calling','ready','review','expired')),
 paid_attempts integer NOT NULL DEFAULT 0 CHECK(paid_attempts BETWEEN 0 AND 2),
 concepts jsonb CHECK(concepts IS NULL OR (jsonb_typeof(concepts)='array' AND jsonb_array_length(concepts) BETWEEN 1 AND 3 AND octet_length(concepts::text)<=65536)),
 reason text CHECK(length(reason)<=200),
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(deadline_at>created_at AND deadline_at<=created_at+interval '30 minutes'),
 CHECK(state<>'ready' OR concepts IS NOT NULL)
);
CREATE UNIQUE INDEX social_draft_active_source ON social_draft_requests(workspace_id,owner_user_id,source_hash,prompt_version) WHERE state IN ('queued','calling');
CREATE INDEX social_draft_due ON social_draft_requests(workspace_id,created_at) WHERE state IN ('queued','calling');
GRANT SELECT,INSERT,UPDATE,DELETE ON social_draft_requests TO app_runtime,migration;
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft')),
 DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply','social_draft') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
