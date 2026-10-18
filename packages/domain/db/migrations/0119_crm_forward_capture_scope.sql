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

-- Preserve the existing native source trigger and history, but mail-only owner
-- consent cannot create a selected-note generation or job at capture time.
CREATE OR REPLACE FUNCTION enqueue_crm_selected_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured crm_extraction_purposes%ROWTYPE; generation uuid; captured jsonb; context_identity text;
BEGIN
 IF NEW.availability<>'available' THEN RETURN NEW; END IF;
 -- The deferred source trigger sees the receipt committed with the selected file.
 -- Import/recapture never authorizes automatic attachment analysis.
 IF EXISTS(SELECT 1 FROM crm_selected_file_receipts WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.revision=NEW.revision AND OLD.content_hash IS NOT DISTINCT FROM NEW.content_hash THEN RETURN NEW; END IF;
 SELECT * INTO configured FROM crm_extraction_purposes WHERE workspace_id=NEW.workspace_id AND enabled;
 IF NOT FOUND OR NOT ('selected_note'=ANY(configured.allowed_source_kinds)) THEN RETURN NEW; END IF;
 captured:=crm_selected_processing_context(NEW.workspace_id,NEW.id,NEW.revision,NEW.content_hash);
 IF captured IS NULL THEN RETURN NEW; END IF;
 context_identity:=crm_processing_context_hash(captured);
 INSERT INTO crm_extraction_generations(workspace_id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,purpose_revision,model_version,state,context_snapshot,context_hash,source_owner_user_id)
 VALUES(NEW.workspace_id,NEW.id,'selected_note',NEW.revision,NEW.content_hash,NEW.owner_user_id,'crm-extract-v1',configured.revision,configured.model_version,'pending',captured,context_identity,NEW.owner_user_id) ON CONFLICT DO NOTHING RETURNING id INTO generation;
 IF generation IS NULL THEN
 SELECT id INTO generation FROM crm_extraction_generations WHERE workspace_id=NEW.workspace_id AND source_kind='selected_note' AND source_id=NEW.id AND source_revision=NEW.revision AND source_hash=NEW.content_hash AND purpose_revision=configured.revision AND processor_version='crm-extract-v1' AND context_hash=context_identity;
 END IF;
 INSERT INTO jobs(workspace_id,kind,payload,idempotency_key,max_attempts)
 VALUES(NEW.workspace_id,'crm.extract',jsonb_build_object('generationId',generation),'crm-extract:'||generation::text,3) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING;
 RETURN NEW;
EXCEPTION WHEN OTHERS THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_selected_extraction_enqueue',MESSAGE=SQLERRM;
END;
$$;
