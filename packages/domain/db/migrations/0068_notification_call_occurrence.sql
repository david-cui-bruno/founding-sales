-- changes: actionable_notification_attempts
-- Current call authority includes Cal.com's current booking UID. Retained targets
-- without it stay readable and keep their durable suppression markers unchanged.
ALTER TABLE actionable_notification_attempts
  DROP CONSTRAINT actionable_notification_attempts_target_check;
ALTER TABLE actionable_notification_attempts
  ADD CONSTRAINT actionable_notification_attempts_target_check CHECK (
    jsonb_typeof(target)='object' AND (
      (target->>'kind'='reply' AND target ?& ARRAY['kind','firmId','messageId']
        AND target - ARRAY['kind','firmId','messageId']='{}'::jsonb)
      OR (target->>'kind'='meeting' AND target ?& ARRAY['kind','firmId','meetingId','startsAt']
        AND target - ARRAY['kind','firmId','meetingId','startsAt','bookingUid']='{}'::jsonb
        AND (NOT (target ? 'bookingUid') OR (
          jsonb_typeof(target->'bookingUid')='string'
          AND target->>'bookingUid' ~ '^[A-Za-z0-9_-]{1,128}$'
        )))
      OR (target->>'kind'='settings' AND target ?& ARRAY['kind','tab','section','mailboxId']
        AND target - ARRAY['kind','tab','section','mailboxId']='{}'::jsonb)
    )
  );
