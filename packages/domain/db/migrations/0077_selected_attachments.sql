-- Provisional lane77. Root assigns final migration order across concurrent lanes.
CREATE TABLE crm_selected_file_receipts (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 metadata_revision integer NOT NULL CHECK(metadata_revision>0),
 file_hash text CHECK(file_hash ~ '^[a-f0-9]{64}$'),
 source_content_hash text CHECK(source_content_hash ~ '^[a-f0-9]{64}$'),
 file_name text CHECK(length(file_name) BETWEEN 1 AND 240),
 byte_length integer CHECK(byte_length BETWEEN 1 AND 80000),
 format text CHECK(format IN ('utf8_text','utf8_markdown','utf8_csv','utf8_srt','utf8_vtt')),
 parser_version text CHECK(parser_version='selected-file-utf8-v1'),
 origin text CHECK(origin='user_selected_original'),
 state text NOT NULL CHECK(state IN ('selected','stale','deleted','awaiting_selection')),
 PRIMARY KEY(workspace_id,source_id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 CHECK(state<>'selected' OR (file_hash IS NOT NULL AND source_content_hash IS NOT NULL AND file_name IS NOT NULL AND byte_length IS NOT NULL AND format IS NOT NULL AND parser_version IS NOT NULL AND origin IS NOT NULL))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_selected_file_receipts TO app_runtime,migration;
CREATE FUNCTION redact_selected_file_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.availability='deleted' THEN
  UPDATE crm_selected_file_receipts SET state='deleted',source_revision=NEW.revision,file_hash=NULL,source_content_hash=NULL,file_name=NULL,byte_length=NULL,format=NULL,parser_version=NULL,origin=NULL WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id;
 ELSIF NEW.availability='awaiting_recapture' THEN
  UPDATE crm_selected_file_receipts SET state='awaiting_selection',source_revision=NEW.revision WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id;
 ELSIF NEW.revision IS DISTINCT FROM OLD.revision OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
  UPDATE crm_selected_file_receipts SET state='stale' WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id AND state='selected';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER selected_file_receipt_deletion AFTER UPDATE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION redact_selected_file_receipt();
