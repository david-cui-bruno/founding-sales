-- changes: provider_reservations
CREATE TABLE outreach_settings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 routine_replies_enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_reply_requests (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 plan_id uuid NOT NULL,
 message_id uuid,
 original_message_id uuid NOT NULL,
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 prompt_version text NOT NULL,
 model_name text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','calling','ready','review','no_reply','delivered','expired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 paid_attempts integer NOT NULL DEFAULT 0 CHECK(paid_attempts BETWEEN 0 AND 2),
 decision jsonb,
 reason text CHECK(length(reason)<=200),
 created_at timestamptz NOT NULL DEFAULT now(),
 deadline_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,original_message_id),
 FOREIGN KEY(workspace_id,plan_id) REFERENCES outreach_plans(workspace_id,id),
 FOREIGN KEY(workspace_id,message_id) REFERENCES mail_messages(workspace_id,id) ON DELETE SET NULL(message_id),
 CONSTRAINT outreach_reply_deadline CHECK(deadline_at>created_at),
 CONSTRAINT outreach_reply_decision CHECK((state NOT IN ('ready','delivered')) OR (decision IS NOT NULL AND decision->>'kind'='answer'))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_settings,outreach_reply_requests TO app_runtime,migration;
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN ('research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis','meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply')),
 DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
