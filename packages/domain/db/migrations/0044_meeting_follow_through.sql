-- changes: meeting_tasks, workspace_settings, sending_domains
-- Per-meeting content and permission scope; delivery remains in the existing sequence/fence tables.
CREATE TABLE meeting_follow_through (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL, firm_id uuid NOT NULL, contact_id uuid, owner_user_id uuid,
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'), notes_revision integer NOT NULL CHECK(notes_revision>=0),
  analysis_id uuid, sequence_version_id uuid, permission_id uuid, enrollment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), current_draft_version integer NOT NULL DEFAULT 0 CHECK(current_draft_version>=0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','held','scheduled','awaiting_reply','completed','cancelled','needs_review')),
  scope jsonb, blockers jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(blockers)='array'),
  editing boolean NOT NULL DEFAULT false, pause_observed_at timestamptz,
  reviewed_at timestamptz, reviewed_draft_version integer NOT NULL DEFAULT 0 CHECK(reviewed_draft_version>=0),
  next_wake_at timestamptz NOT NULL DEFAULT now(), wake_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,id,meeting_id), UNIQUE(workspace_id,enrollment_id),
  FOREIGN KEY(workspace_id,meeting_id,firm_id) REFERENCES meetings(workspace_id,id,firm_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY(workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE,
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
  FOREIGN KEY(workspace_id,analysis_id,meeting_id) REFERENCES meeting_analyses(workspace_id,id,meeting_id) ON DELETE SET NULL (analysis_id) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY(workspace_id,sequence_version_id) REFERENCES sequence_versions(workspace_id,id),
  FOREIGN KEY(workspace_id,permission_id) REFERENCES follow_up_permissions(workspace_id,id),
  FOREIGN KEY(workspace_id,enrollment_id) REFERENCES sequence_enrollments(workspace_id,id)
);
CREATE UNIQUE INDEX meeting_follow_through_one_current ON meeting_follow_through(workspace_id,meeting_id) WHERE status NOT IN ('cancelled','completed');
CREATE INDEX meeting_follow_through_due ON meeting_follow_through(next_wake_at,id) WHERE status NOT IN ('cancelled','completed');
CREATE TABLE meeting_follow_through_drafts (
  workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), plan_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), ordinal integer NOT NULL DEFAULT 1 CHECK(ordinal BETWEEN 1 AND 3),
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 998 AND subject !~ E'[\r\n]'),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000), rendered_hash text NOT NULL CHECK(rendered_hash ~ '^[a-f0-9]{64}$'),
  template_version_id uuid NOT NULL, template_content_hash text NOT NULL CHECK(template_content_hash ~ '^[a-f0-9]{64}$'),
  outbound_message_id uuid, manual_message_id uuid, material_task_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(material_task_ids)='array'), source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  material_references jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(material_references)='array'),
  created_at timestamptz NOT NULL, not_before timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','held','editing','cancelled','superseded','submitted','sent')),
  created_by_user_id uuid,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,plan_id,version),
  FOREIGN KEY(workspace_id,plan_id) REFERENCES meeting_follow_through(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,template_version_id) REFERENCES template_versions(workspace_id,id),
  FOREIGN KEY(workspace_id,outbound_message_id) REFERENCES outbound_messages(workspace_id,id),
  CONSTRAINT meeting_draft_manual_message FOREIGN KEY(workspace_id,manual_message_id) REFERENCES mail_messages(workspace_id,id) ON DELETE SET NULL (manual_message_id),
  FOREIGN KEY(workspace_id,created_by_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
  CHECK(not_before>=created_at), CHECK(NOT email_has_optout_link(subject) AND NOT email_has_optout_link(body))
);
CREATE FUNCTION keep_meeting_draft_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'state'-'outbound_message_id'-'manual_message_id') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'outbound_message_id'-'manual_message_id')
    OR (OLD.outbound_message_id IS NOT NULL AND NEW.outbound_message_id IS DISTINCT FROM OLD.outbound_message_id) OR (OLD.manual_message_id IS NOT NULL AND NEW.manual_message_id IS NOT NULL AND NEW.manual_message_id IS DISTINCT FROM OLD.manual_message_id) THEN
    RAISE EXCEPTION 'meeting draft revisions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_draft_bytes BEFORE UPDATE ON meeting_follow_through_drafts FOR EACH ROW EXECUTE FUNCTION keep_meeting_draft_bytes();
ALTER TABLE meeting_tasks ALTER COLUMN commitment_id DROP NOT NULL,
  ADD COLUMN follow_through_plan_id uuid,
  ADD CONSTRAINT meeting_tasks_plan_source FOREIGN KEY(workspace_id,follow_through_plan_id,meeting_id)
    REFERENCES meeting_follow_through(workspace_id,id,meeting_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT meeting_tasks_one_source CHECK((commitment_id IS NULL) <> (follow_through_plan_id IS NULL)),
  ADD CONSTRAINT meeting_tasks_one_per_plan UNIQUE(workspace_id,follow_through_plan_id),
  DROP CONSTRAINT meeting_tasks_evidence_check,
  ADD CONSTRAINT meeting_tasks_evidence_check CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)<=20 AND (follow_through_plan_id IS NOT NULL OR jsonb_array_length(evidence)>=1));
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
  ADD CONSTRAINT workspace_settings_key_known
  CHECK (setting_key IN ('business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration','telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents','meeting_transcription','meeting_analysis','meeting_follow_through'));
GRANT SELECT,INSERT,UPDATE,DELETE ON meeting_follow_through,meeting_follow_through_drafts TO app_runtime,migration;

-- Remember even a pause that begins and ends between scheduler passes. Writers hold
-- the exclusive send gate; final claims cannot miss the new editing-window barrier.
CREATE FUNCTION note_meeting_domain_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_follow_through p SET pause_observed_at=COALESCE(p.pause_observed_at,clock_timestamp()),
    next_wake_at=LEAST(p.next_wake_at,clock_timestamp())
    WHERE p.workspace_id=NEW.workspace_id AND p.status NOT IN ('cancelled','completed')
    AND EXISTS(SELECT 1 FROM mailboxes b WHERE b.workspace_id=p.workspace_id
      AND b.owner_user_id=p.owner_user_id AND lower(split_part(b.email_address,'@',2))=NEW.domain);
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_domain_pause AFTER UPDATE OF automated_sending_enabled ON sending_domains
  FOR EACH ROW WHEN (NOT NEW.automated_sending_enabled) EXECUTE FUNCTION note_meeting_domain_pause();
CREATE FUNCTION note_meeting_workspace_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE meeting_follow_through p SET pause_observed_at=COALESCE(p.pause_observed_at,clock_timestamp()),
    next_wake_at=LEAST(p.next_wake_at,clock_timestamp())
    WHERE p.workspace_id=NEW.workspace_id AND p.status NOT IN ('cancelled','completed');
  RETURN NEW;
END;
$$;
CREATE TRIGGER meeting_workspace_pause AFTER INSERT OR UPDATE OF value ON workspace_settings
  FOR EACH ROW WHEN (NEW.setting_key='sending_enabled' AND NEW.value->>'enabled'='false')
  EXECUTE FUNCTION note_meeting_workspace_pause();
