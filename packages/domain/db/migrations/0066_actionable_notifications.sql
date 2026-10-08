-- changes: actionable_notification_attempts
-- A workspace/user/event gets one durable submission, independent of device.
-- Its UUID is also the native request identity. Never delete a marker to retry.
CREATE TABLE actionable_notification_attempts (
 workspace_id uuid NOT NULL,
 attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL,
 device_id uuid NOT NULL,
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 240),
 action_id text NOT NULL CHECK(length(action_id) BETWEEN 1 AND 180),
 phase text NOT NULL CHECK(phase IN ('attention','reply_overdue','pre_call')),
 target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND (
   (target->>'kind'='reply' AND target ?& ARRAY['kind','firmId','messageId'] AND target - ARRAY['kind','firmId','messageId']='{}'::jsonb)
   OR (target->>'kind'='meeting' AND target ?& ARRAY['kind','firmId','meetingId','startsAt'] AND target - ARRAY['kind','firmId','meetingId','startsAt']='{}'::jsonb)
   OR (target->>'kind'='settings' AND target ?& ARRAY['kind','tab','section','mailboxId'] AND target - ARRAY['kind','tab','section','mailboxId']='{}'::jsonb)
 )),
 status text NOT NULL DEFAULT 'attempting' CHECK(status IN ('attempting','native_shown','acknowledged','failed','unknown')),
 attempted_at timestamptz NOT NULL,
 native_shown_at timestamptz,
 acknowledged_at timestamptz,
 failed_at timestamptz,
 unknown_at timestamptz,
 PRIMARY KEY(workspace_id,attempt_id),
 UNIQUE(workspace_id,user_id,event_key),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,device_id) REFERENCES devices(workspace_id,id),
 CHECK((status='acknowledged')=(acknowledged_at IS NOT NULL)),
 CHECK(status<>'native_shown' OR native_shown_at IS NOT NULL),
 CHECK(status<>'failed' OR failed_at IS NOT NULL),
 CHECK(status<>'unknown' OR unknown_at IS NOT NULL)
);
GRANT SELECT,INSERT,UPDATE ON actionable_notification_attempts TO app_runtime,migration;
