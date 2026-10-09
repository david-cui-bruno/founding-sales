-- Provisional lane72; integration owner reserves final73.
ALTER TABLE crm_selected_sources DROP CONSTRAINT crm_selected_sources_check2;
ALTER TABLE crm_selected_sources ADD CONSTRAINT crm_selected_sources_date_availability CHECK (availability='available' OR occurred_at IS NULL);
CREATE TABLE crm_selected_imports (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  import_key_hash text NOT NULL CHECK(import_key_hash ~ '^[a-f0-9]{64}$'),
  input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  parser_version text NOT NULL CHECK(parser_version='selected-v1'),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  subtype text NOT NULL CHECK(subtype IN ('pasted_text','transcript','selected_file')),
  label text CHECK(label IS NULL OR (btrim(label)<>'' AND length(label)<=240)),
  participants jsonb CHECK(participants IS NULL OR (jsonb_typeof(participants)='array' AND jsonb_array_length(participants)<=20 AND octet_length(participants::text)<=20000)),
  attachments jsonb CHECK(attachments IS NULL OR (jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments)<=20 AND octet_length(attachments::text)<=50000)),
  direction text CHECK(direction IN ('incoming','outgoing','draft','unknown')),
  attribution text CHECK(attribution IN ('unknown','asserted')),
  date_provenance text CHECK(date_provenance IN ('parsed','user_supplied','unknown')),
  PRIMARY KEY(workspace_id,source_id),
  UNIQUE(workspace_id,owner_user_id,import_key_hash),
  FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
-- All existing source deletion paths redact metadata in the same transaction.
CREATE FUNCTION redact_selected_import_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.availability='deleted' AND OLD.availability<>'deleted' THEN
  UPDATE crm_selected_imports SET label=NULL,participants=NULL,attachments=NULL,direction=NULL,attribution=NULL,date_provenance=NULL,revision=revision+1 WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_import_metadata_deletion AFTER UPDATE OF availability ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION redact_selected_import_metadata();
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_selected_imports TO app_runtime,migration;
