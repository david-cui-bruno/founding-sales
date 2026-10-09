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
CREATE FUNCTION enforce_selected_file_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM crm_selected_file_receipts f WHERE f.workspace_id=NEW.workspace_id AND f.source_id=NEW.source_id AND f.state='selected'
  AND NOT EXISTS(SELECT 1 FROM crm_selected_sources s JOIN crm_selected_imports m ON m.workspace_id=s.workspace_id AND m.source_id=s.id
   WHERE s.workspace_id=f.workspace_id AND s.id=f.source_id AND s.availability='available' AND s.revision=f.source_revision AND s.content_hash=f.source_content_hash
   AND m.revision=f.metadata_revision AND m.subtype='selected_file')) THEN
  RAISE EXCEPTION 'Selected file provenance changed' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_selected_file_current_provenance AFTER INSERT OR UPDATE ON crm_selected_file_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_selected_file_provenance();
CREATE CONSTRAINT TRIGGER crm_selected_file_current_metadata AFTER UPDATE ON crm_selected_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_selected_file_provenance();

CREATE OR REPLACE FUNCTION enqueue_crm_selected_extraction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configured crm_extraction_purposes%ROWTYPE; generation uuid; captured jsonb; context_identity text;
BEGIN
 IF NEW.availability<>'available' THEN RETURN NEW; END IF;
 -- The deferred source trigger sees the receipt committed with the selected file.
 -- Import/recapture never authorizes automatic attachment analysis.
 IF EXISTS(SELECT 1 FROM crm_selected_file_receipts WHERE workspace_id=NEW.workspace_id AND source_id=NEW.id) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.revision=NEW.revision AND OLD.content_hash IS NOT DISTINCT FROM NEW.content_hash THEN RETURN NEW; END IF;
 SELECT * INTO configured FROM crm_extraction_purposes WHERE workspace_id=NEW.workspace_id AND enabled;
 IF NOT FOUND THEN RETURN NEW; END IF;
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
