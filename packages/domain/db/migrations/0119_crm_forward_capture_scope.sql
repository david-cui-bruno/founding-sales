-- changes: crm_capability_owner_approvals, crm_extraction_purposes
-- Historical NULL scope remains documentary consent, never new capture or AI
-- authority. The existing immutable approval ID identifies a capture epoch.
-- Its cutoff is date_trunc('milliseconds', approved_at) + interval '1 millisecond',
-- also retained in the canonical scope_configuration used by its fingerprint.
-- No timestamp, approval, activation or older-message scope is backfilled here.
ALTER TABLE crm_capability_owner_approvals
  ADD COLUMN scope_configuration jsonb,
  ADD CONSTRAINT crm_owner_approval_scope_object CHECK (
    scope_configuration IS NULL OR jsonb_typeof(scope_configuration) = 'object'
  );

-- Empty scope preserves old settings without inventing mail/native authority.
-- This owner-approved capability intentionally supports mail only. Independent
-- call-analysis features and retained source/history access are unchanged.
ALTER TABLE crm_extraction_purposes
  ADD COLUMN allowed_source_kinds text[] NOT NULL DEFAULT '{}',
  ADD COLUMN mail_capture_owner_approval_id uuid,
  ADD CONSTRAINT crm_extraction_allowed_source_kinds CHECK (
    allowed_source_kinds IN ('{}'::text[], ARRAY['mail']::text[])
  ),
  ADD CONSTRAINT crm_extraction_source_scope_binding CHECK (
    (allowed_source_kinds = '{}'::text[] AND mail_capture_owner_approval_id IS NULL)
    OR (allowed_source_kinds = ARRAY['mail']::text[] AND mail_capture_owner_approval_id IS NOT NULL)
  ),
  ADD CONSTRAINT crm_extraction_capture_approval_fk
    FOREIGN KEY (workspace_id, mail_capture_owner_approval_id)
    REFERENCES crm_capability_owner_approvals(workspace_id, id);
