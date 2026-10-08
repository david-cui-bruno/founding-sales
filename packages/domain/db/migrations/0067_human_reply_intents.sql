-- changes: human_reply_send_intents
-- Bodies remain on the original outbound fence; approval metadata never grants a retry
-- after provider submission. The source identity outlives body retention for readback.
CREATE TABLE human_reply_send_intents (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 message_id uuid NOT NULL,
 outbound_message_id uuid NOT NULL,
 user_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','salesperson')),
 session_id uuid NOT NULL,
 device_id uuid NOT NULL,
 command_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized boolean NOT NULL DEFAULT true,
 expires_at timestamptz NOT NULL,
 source_revision text NOT NULL CHECK(source_revision ~ '^[a-f0-9]{64}$'),
 draft_revision text NOT NULL CHECK(draft_revision ~ '^[a-f0-9]{64}$'),
 fact_refs jsonb NOT NULL CHECK(jsonb_typeof(fact_refs)='array' AND jsonb_array_length(fact_refs)<=20),
 envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object' AND envelope ?& ARRAY['to','cc'] AND envelope-ARRAY['to','cc']='{}'::jsonb AND jsonb_typeof(envelope->'to')='array' AND jsonb_array_length(envelope->'to') BETWEEN 1 AND 10 AND jsonb_typeof(envelope->'cc')='array' AND jsonb_array_length(envelope->'cc')<=10),
 provider_thread_id text NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 500),
 in_reply_to text NOT NULL CHECK(length(in_reply_to) BETWEEN 1 AND 998),
 reference_ids jsonb NOT NULL CHECK(jsonb_typeof(reference_ids)='array' AND jsonb_array_length(reference_ids)<=101),
 author_address text NOT NULL CHECK(author_address ~ '^[^[:space:]<>]+@[^[:space:]<>]+$'),
 refusal text CHECK(refusal ~ '^[a-z0-9_:,-]{1,200}$'),
 PRIMARY KEY(workspace_id,message_id),
 UNIQUE(workspace_id,outbound_message_id),
 FOREIGN KEY(workspace_id,outbound_message_id) REFERENCES outbound_messages(workspace_id,id) ON DELETE CASCADE,
 CHECK(NOT authorized OR refusal IS NULL)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON human_reply_send_intents TO app_runtime,migration;
