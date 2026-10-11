-- changes: crm_ask_index_work, crm_ask_canonical_windows, crm_ask_index_receipts, crm_selected_sources, crm_mail_sources, call_transcripts, meeting_transcripts
CREATE TABLE crm_ask_index_work(
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL,
 scope jsonb, source_scope jsonb, context_snapshot jsonb, original_access_closure jsonb,
 purpose_snapshot jsonb, purpose_revision integer,
 config_fingerprint text CHECK(config_fingerprint IS NULL OR config_fingerprint ~ '^[a-f0-9]{64}$'),
 authorization_fingerprint text CHECK(authorization_fingerprint IS NULL OR authorization_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('pending','partial','complete','unavailable','unknown_acceptance','stale','deleted')),
 reason text, scan_partial boolean NOT NULL DEFAULT false,
 next_ordinal integer NOT NULL DEFAULT 1 CHECK(next_ordinal BETWEEN 1 AND 1001),
 total_windows integer NOT NULL DEFAULT 0 CHECK(total_windows BETWEEN 0 AND 1000), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_ask_index_work_shape CHECK(COALESCE((
 (state IN ('stale','deleted') AND scope IS NULL AND source_scope IS NULL AND context_snapshot IS NULL AND original_access_closure IS NULL)
 OR (state NOT IN ('stale','deleted') AND jsonb_typeof(scope)='object' AND jsonb_typeof(source_scope)='object'
 AND CASE WHEN jsonb_typeof(source_scope->'sources')='array' THEN jsonb_array_length(source_scope->'sources')<=100 ELSE false END
 AND jsonb_typeof(context_snapshot)='array' AND crm_access_closure_valid(original_access_closure))),false)),
 CONSTRAINT crm_ask_index_purpose CHECK(COALESCE(crm_ask_purpose_snapshot_valid(purpose_snapshot) AND purpose_snapshot->>'purpose'='embedding' AND (purpose_snapshot->>'revision')::integer=purpose_revision,false))
);
CREATE TABLE crm_ask_canonical_windows(
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,work_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),source_id uuid NOT NULL,source_revision integer NOT NULL CHECK(source_revision>0),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 locator text NOT NULL CHECK(length(locator) BETWEEN 1 AND 300),text_hash text NOT NULL CHECK(text_hash ~ '^[a-f0-9]{64}$'),context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),context_snapshot jsonb,original_access_closure jsonb,
 parser_version text NOT NULL DEFAULT 'canonical-original-v1',chunker_version text NOT NULL,
 purpose_revision integer NOT NULL CHECK(purpose_revision>0),model_version text NOT NULL,
 dimensions integer NOT NULL CHECK(dimensions IN (256,512,1024)),config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 embedding double precision[],state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','current','stale','deleted')),ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,work_id) REFERENCES crm_ask_index_work(workspace_id,id),FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),UNIQUE(workspace_id,work_id,ordinal),
 CONSTRAINT crm_ask_index_vector CHECK(embedding IS NULL OR cardinality(embedding)=dimensions AND array_position(embedding,NULL) IS NULL AND NOT embedding && ARRAY['Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision] AND embedding<>array_fill(0::double precision,ARRAY[dimensions])),
 CONSTRAINT crm_ask_index_window_shape CHECK(COALESCE(((state IN ('stale','deleted') AND embedding IS NULL AND context_snapshot IS NULL AND original_access_closure IS NULL) OR (state IN ('pending','current') AND crm_extraction_context_valid(context_snapshot) AND crm_access_closure_valid(original_access_closure) AND (state='pending' AND embedding IS NULL OR state='current' AND embedding IS NOT NULL))),false))
);
CREATE INDEX crm_ask_canonical_lookup ON crm_ask_canonical_windows(workspace_id,owner_user_id,source_kind,source_id,source_revision,source_hash,config_fingerprint) WHERE state='current';
CREATE TABLE crm_ask_index_receipts(
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),work_id uuid NOT NULL,window_id uuid NOT NULL,attempt integer NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3),reservation_id uuid NOT NULL,job_id uuid NOT NULL,fencing_token bigint NOT NULL,
 purpose_snapshot jsonb NOT NULL,purpose_revision integer NOT NULL,config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 input_price_micros numeric NOT NULL CHECK(input_price_micros>0),output_price_micros numeric NOT NULL CHECK(output_price_micros>=0),max_input_tokens integer NOT NULL CHECK(max_input_tokens BETWEEN 1 AND 1000000),
 dispatch_state text NOT NULL CHECK(dispatch_state IN ('reserved','calling','settled','released','unknown_acceptance')),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,window_id,attempt),FOREIGN KEY(workspace_id,work_id) REFERENCES crm_ask_index_work(workspace_id,id),FOREIGN KEY(workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id),FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id),
 CONSTRAINT crm_ask_index_receipt_purpose CHECK(COALESCE(crm_ask_purpose_snapshot_valid(purpose_snapshot) AND purpose_snapshot->>'purpose'='embedding' AND (purpose_snapshot->>'revision')::integer=purpose_revision,false))
);
CREATE FUNCTION crm_ask_index_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='crm_ask_index_receipts' THEN
  IF to_jsonb(NEW)-'dispatch_state' IS DISTINCT FROM to_jsonb(OLD)-'dispatch_state' OR OLD.dispatch_state IN ('settled','released','unknown_acceptance') AND NEW.dispatch_state<>OLD.dispatch_state THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_index_receipt_immutable'; END IF;
 ELSE
  IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at,NEW.purpose_snapshot,NEW.purpose_revision,NEW.total_windows,NEW.scan_partial) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at,OLD.purpose_snapshot,OLD.purpose_revision,OLD.total_windows,OLD.scan_partial) AND NOT(OLD.state='pending' AND OLD.total_windows=0 AND NEW.total_windows>=0 AND ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.created_at,NEW.purpose_snapshot,NEW.purpose_revision) IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.created_at,OLD.purpose_snapshot,OLD.purpose_revision)) OR NEW.revision<OLD.revision OR ROW(NEW.scope,NEW.source_scope,NEW.context_snapshot,NEW.original_access_closure) IS DISTINCT FROM ROW(OLD.scope,OLD.source_scope,OLD.context_snapshot,OLD.original_access_closure) AND NOT(NEW.state IN ('stale','deleted') AND NEW.scope IS NULL AND NEW.source_scope IS NULL AND NEW.context_snapshot IS NULL AND NEW.original_access_closure IS NULL) OR OLD.state IN ('stale','deleted') AND NEW.state<>OLD.state AND NOT(OLD.state='stale' AND NEW.state='deleted') THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_index_identity_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_index_identity_guard BEFORE UPDATE ON crm_ask_index_work FOR EACH ROW EXECUTE FUNCTION crm_ask_index_identity_guard();
CREATE TRIGGER crm_ask_index_receipt_guard BEFORE UPDATE ON crm_ask_index_receipts FOR EACH ROW EXECUTE FUNCTION crm_ask_index_identity_guard();
GRANT SELECT,INSERT,UPDATE ON crm_ask_index_work,crm_ask_canonical_windows,crm_ask_index_receipts TO app_runtime,migration;
CREATE FUNCTION crm_ask_index_source_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind_value text; source_id_value uuid; work_ids uuid[]; erased boolean;
BEGIN
 IF TG_TABLE_NAME='crm_selected_sources' THEN source_kind_value:='selected_note';source_id_value:=OLD.id;erased:=TG_OP='DELETE' OR NEW.availability<>'available';
 ELSIF TG_TABLE_NAME='crm_mail_sources' THEN source_kind_value:='mail';source_id_value:=OLD.source_id;erased:=NEW.availability<>'available';
 ELSIF TG_TABLE_NAME='call_transcripts' THEN source_kind_value:='call_transcript';source_id_value:=OLD.call_session_id;erased:=TG_OP='DELETE';
 ELSE source_kind_value:='meeting_transcript';source_id_value:=OLD.id;erased:=TG_OP='DELETE'; END IF;
 SELECT array_agg(DISTINCT id) INTO work_ids FROM crm_ask_index_work w WHERE w.workspace_id=OLD.workspace_id AND w.state NOT IN ('stale','deleted') AND EXISTS(SELECT 1 FROM jsonb_array_elements(w.source_scope->'sources') src WHERE src->>'kind'=source_kind_value AND src->>'sourceId'=source_id_value::text);
 IF work_ids IS NOT NULL THEN
 UPDATE crm_ask_index_work SET state=CASE WHEN erased THEN 'deleted' ELSE 'stale' END,scope=NULL,source_scope=NULL,context_snapshot=NULL,original_access_closure=NULL,reason='source_unavailable',revision=revision+1,updated_at=now() WHERE workspace_id=OLD.workspace_id AND id=ANY(work_ids) AND state NOT IN ('stale','deleted');
 UPDATE crm_ask_canonical_windows SET state=CASE WHEN erased THEN 'deleted' ELSE 'stale' END,embedding=NULL,context_snapshot=NULL,original_access_closure=NULL WHERE workspace_id=OLD.workspace_id AND work_id=ANY(work_ids) AND state IN ('pending','current');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_index_selected_invalidated AFTER UPDATE OF availability,revision,content_hash ON crm_selected_sources FOR EACH ROW WHEN(OLD.availability IS DISTINCT FROM NEW.availability OR OLD.revision IS DISTINCT FROM NEW.revision OR OLD.content_hash IS DISTINCT FROM NEW.content_hash) EXECUTE FUNCTION crm_ask_index_source_invalidated();
CREATE TRIGGER crm_ask_index_mail_invalidated AFTER UPDATE OF availability,source_revision,content_hash ON crm_mail_sources FOR EACH ROW WHEN(OLD.availability IS DISTINCT FROM NEW.availability OR OLD.source_revision IS DISTINCT FROM NEW.source_revision OR OLD.content_hash IS DISTINCT FROM NEW.content_hash) EXECUTE FUNCTION crm_ask_index_source_invalidated();

CREATE TRIGGER crm_ask_index_call_invalidated AFTER UPDATE OF crm_revision OR DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION crm_ask_index_source_invalidated();
CREATE TRIGGER crm_ask_index_meeting_invalidated AFTER UPDATE OF version OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION crm_ask_index_source_invalidated();
CREATE FUNCTION crm_ask_canonical_window_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','embedding','context_snapshot','original_access_closure','config_fingerprint']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','embedding','context_snapshot','original_access_closure','config_fingerprint'])
 OR OLD.state IN ('stale','deleted') AND NEW.state<>OLD.state AND NOT(OLD.state='stale' AND NEW.state='deleted')
 OR ROW(NEW.context_snapshot,NEW.original_access_closure) IS DISTINCT FROM ROW(OLD.context_snapshot,OLD.original_access_closure) AND NOT(NEW.state IN ('stale','deleted') AND NEW.context_snapshot IS NULL AND NEW.original_access_closure IS NULL)
 OR OLD.state='current' AND NEW.state='pending'
 OR OLD.state='current' AND NEW.state='current' AND ROW(NEW.embedding,NEW.config_fingerprint) IS DISTINCT FROM ROW(OLD.embedding,OLD.config_fingerprint) THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_canonical_window_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_canonical_window_guard BEFORE UPDATE ON crm_ask_canonical_windows FOR EACH ROW EXECUTE FUNCTION crm_ask_canonical_window_guard();
/** Canonical projections inherit the frozen owner/source/context of their work. */
CREATE FUNCTION crm_ask_canonical_window_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent crm_ask_index_work%ROWTYPE; source_position bigint;
BEGIN
 SELECT * INTO parent FROM crm_ask_index_work WHERE workspace_id=NEW.workspace_id AND id=NEW.work_id FOR SHARE;
 SELECT ordinal INTO source_position FROM jsonb_array_elements(parent.source_scope->'sources') WITH ORDINALITY AS source(value,ordinal)
 WHERE value->>'workspaceId'=NEW.workspace_id::text AND value->>'kind'=NEW.source_kind AND value->>'sourceId'=NEW.source_id::text AND value->>'revision'=NEW.source_revision::text AND value->>'contentHash'=NEW.source_hash LIMIT 1;
 IF parent.id IS NULL OR parent.owner_user_id<>NEW.owner_user_id OR parent.state<>'pending' OR source_position IS NULL
 OR parent.context_snapshot->(source_position::integer-1) IS DISTINCT FROM NEW.context_snapshot
 OR NOT COALESCE((parent.original_access_closure->'firmIds') @> (NEW.original_access_closure->'firmIds') AND (parent.original_access_closure->'personIds') @> (NEW.original_access_closure->'personIds'),false)
 OR parent.purpose_revision<>NEW.purpose_revision OR parent.purpose_snapshot->>'modelVersion' IS DISTINCT FROM NEW.model_version
 OR parent.purpose_snapshot->>'chunkerVersion' IS DISTINCT FROM NEW.chunker_version OR parent.purpose_snapshot->>'embeddingDimensions' IS DISTINCT FROM NEW.dimensions::text
 OR NEW.state<>'pending' OR NEW.embedding IS NOT NULL THEN
 RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='crm_ask_canonical_window_binding'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_canonical_window_binding AFTER INSERT ON crm_ask_canonical_windows DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_canonical_window_binding();
