-- #621: body-free durable create identity. Unknown dispatches never return to pending.
CREATE TABLE booking_create_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 owner_user_id uuid NOT NULL REFERENCES users(id),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 binding_key text NOT NULL CHECK(length(binding_key) BETWEEN 1 AND 256),
 provider_account_id bigint NOT NULL CHECK(provider_account_id>0),
 event_type_id bigint NOT NULL CHECK(event_type_id>0),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 starts_at timestamptz NOT NULL,
 buffer_ends_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','failed','unknown')),
 dispatch_started_at timestamptz,
 provider_booking_uid text CHECK(provider_booking_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
 meeting_id uuid,
 reason text CHECK(reason ~ '^[a-z][a-z0-9_]{1,79}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT booking_create_identity UNIQUE(workspace_id,owner_user_id,request_hash),
 CONSTRAINT booking_create_workspace_id UNIQUE(workspace_id,id),
 CONSTRAINT booking_create_meeting FOREIGN KEY(workspace_id,meeting_id) REFERENCES meetings(workspace_id,id) ON DELETE SET NULL (meeting_id),
 CONSTRAINT booking_create_window CHECK(buffer_ends_at=starts_at+interval '30 minutes'),
 CONSTRAINT booking_create_accepted_evidence CHECK(state<>'accepted' OR (dispatch_started_at IS NOT NULL AND provider_booking_uid IS NOT NULL)),
 CONSTRAINT booking_create_unknown_dispatch CHECK(state<>'unknown' OR dispatch_started_at IS NOT NULL)
);
CREATE INDEX booking_create_slot_gate ON booking_create_submissions(workspace_id,provider_account_id,starts_at) WHERE state IN ('pending','accepted','unknown');
GRANT SELECT,INSERT,UPDATE ON booking_create_submissions TO app_runtime;
