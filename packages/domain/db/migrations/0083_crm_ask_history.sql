-- #494 owner-private history shares the existing request identity and copied input.
ALTER TABLE crm_ask_requests
 ADD COLUMN history_revision integer NOT NULL DEFAULT 1 CONSTRAINT crm_ask_history_revision_positive CHECK(history_revision>0),
 ADD COLUMN history_title text CONSTRAINT crm_ask_history_title_bound CHECK(history_title IS NULL OR length(btrim(history_title)) BETWEEN 1 AND 100),
 ADD COLUMN history_pinned boolean NOT NULL DEFAULT false,
 ADD COLUMN history_updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE crm_ask_requests SET history_updated_at=created_at;
CREATE INDEX crm_ask_owner_history ON crm_ask_requests(workspace_id,owner_user_id,history_pinned DESC,created_at DESC,id DESC);

CREATE FUNCTION crm_ask_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.history_revision NOT IN (OLD.history_revision,OLD.history_revision+1) THEN
  RAISE EXCEPTION 'History revision must advance once' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
 END IF;
 IF NEW.question IS NULL OR NEW.state IN ('stale','deleted') THEN NEW.history_title=NULL;NEW.history_pinned=false; END IF;
 IF ROW(NEW.history_title,NEW.history_pinned,NEW.state,NEW.version,NEW.epoch) IS DISTINCT FROM ROW(OLD.history_title,OLD.history_pinned,OLD.state,OLD.version,OLD.epoch) THEN
  NEW.history_revision=OLD.history_revision+1;NEW.history_updated_at=clock_timestamp();
 ELSE NEW.history_revision=OLD.history_revision;NEW.history_updated_at=OLD.history_updated_at;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_history_guard BEFORE UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION crm_ask_history_guard();

CREATE TABLE crm_ask_actions (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 source_request_id uuid NOT NULL,source_request_version integer NOT NULL CHECK(source_request_version>0),
 kind text NOT NULL,
 status text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),private_state text NOT NULL DEFAULT 'available' CHECK(private_state IN ('available','stale','deleted')),
 target_firm_id uuid,target_person_id uuid,
 human_text text,due jsonb,input_scope jsonb,initial_contexts jsonb,original_access_closure jsonb,support_refs jsonb,
 review_required boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,source_request_id) REFERENCES crm_ask_requests(workspace_id,id),
 FOREIGN KEY(workspace_id,target_firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,target_person_id) REFERENCES crm_people(workspace_id,id),
 CONSTRAINT crm_ask_action_status CHECK((kind='task' AND status IN ('open','done','cancelled')) OR (kind='note' AND status='active') OR (kind='preference' AND status IN ('proposed','dismissed'))),
 CONSTRAINT crm_ask_action_completion CHECK((kind='task' AND status='done')=(completed_at IS NOT NULL)),
 CONSTRAINT crm_ask_action_private_shape CHECK(
  (private_state<>'available' AND target_firm_id IS NULL AND target_person_id IS NULL AND human_text IS NULL AND due IS NULL AND input_scope IS NULL AND initial_contexts IS NULL AND original_access_closure IS NULL AND support_refs IS NULL)
  OR (private_state='available' AND human_text IS NOT NULL AND length(btrim(human_text)) BETWEEN 1 AND CASE WHEN kind='task' THEN 300 ELSE 2000 END
   AND crm_ask_input_valid(workspace_id,input_scope,initial_contexts,original_access_closure)
   AND support_refs IS NOT NULL AND jsonb_typeof(support_refs)='array' AND jsonb_array_length(support_refs) BETWEEN 1 AND 10
   AND ((kind='preference' AND target_firm_id IS NULL AND target_person_id IS NULL) OR (kind<>'preference' AND ((target_firm_id IS NOT NULL)::integer+(target_person_id IS NOT NULL)::integer)=1))
   AND (kind='task' OR due IS NULL)))
);
CREATE INDEX crm_ask_manual_owner ON crm_ask_actions(workspace_id,owner_user_id,id);
GRANT SELECT,INSERT,UPDATE ON crm_ask_actions TO app_runtime,migration;

CREATE FUNCTION crm_ask_action_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent crm_ask_requests%ROWTYPE;
BEGIN
 SELECT * INTO parent FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.source_request_id FOR SHARE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.private_state<>'available' OR parent.question IS NULL OR parent.state IN ('stale','deleted')
  OR NEW.owner_user_id<>parent.owner_user_id OR NEW.source_request_version<>parent.version
  OR NEW.input_scope IS DISTINCT FROM parent.scope
  OR NEW.initial_contexts IS DISTINCT FROM parent.initial_contexts
  OR NEW.original_access_closure IS DISTINCT FROM parent.initial_access_closure
  OR (NEW.target_person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(parent.initial_contexts) ctx WHERE ctx->>'personId'=NEW.target_person_id::text))
  OR (NEW.target_firm_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(parent.initial_contexts) ctx,jsonb_array_elements_text(ctx->'firmIds') firm WHERE firm=NEW.target_firm_id::text)) THEN
  RAISE EXCEPTION 'Manual action must bind its current investigation owner and proof' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_action_current_request AFTER INSERT ON crm_ask_actions DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_action_request_guard();

CREATE FUNCTION crm_ask_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.source_request_id,NEW.source_request_version,NEW.kind,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.source_request_id,OLD.source_request_version,OLD.kind,OLD.created_at)
 OR (NEW.private_state='available' AND ROW(NEW.target_firm_id,NEW.target_person_id,NEW.human_text,NEW.due,NEW.input_scope,NEW.initial_contexts,NEW.original_access_closure,NEW.support_refs)
  IS DISTINCT FROM ROW(OLD.target_firm_id,OLD.target_person_id,OLD.human_text,OLD.due,OLD.input_scope,OLD.initial_contexts,OLD.original_access_closure,OLD.support_refs))
 OR (OLD.private_state<>'available' AND NEW.private_state='available')
 OR (OLD.status IN ('done','cancelled','dismissed') AND NEW.status<>OLD.status)
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 OR NEW.version<OLD.version OR NEW.version>OLD.version+1 THEN
  RAISE EXCEPTION 'Human action identity and copied support are immutable' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_action_immutable AFTER UPDATE ON crm_ask_actions DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_action_guard();

CREATE FUNCTION crm_ask_action_support_valid(ws uuid,scope jsonb,refs jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE ref jsonb;
BEGIN
 IF refs IS NULL OR jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs) NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(refs))<>jsonb_array_length(refs) THEN RETURN false; END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(ref)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(ref))<>6
   OR NOT(ref ?& ARRAY['workspaceId','sourceId','kind','revision','contentHash','locator'])
   OR ref->>'workspaceId'<>ws::text OR jsonb_typeof(ref->'locator')<>'string'
   OR length(ref->>'locator') NOT BETWEEN 1 AND 500
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'sources') source WHERE source=jsonb_set(ref,'{locator}','null'::jsonb)) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE crm_ask_actions ADD CONSTRAINT crm_ask_action_support CHECK(private_state<>'available' OR crm_ask_action_support_valid(workspace_id,input_scope,support_refs));

CREATE FUNCTION crm_ask_action_due_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE date_text text;
BEGIN
 IF value IS NULL OR value='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>4
  OR jsonb_typeof(value->'kind')<>'string' OR value->>'kind' NOT IN ('date','instant')
  OR jsonb_typeof(value->'zone')<>'string' OR length(value->>'zone') NOT BETWEEN 1 AND 100
  OR jsonb_typeof(value->'expression')<>'string' OR length(btrim(value->>'expression')) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
 PERFORM timezone(value->>'zone',TIMESTAMPTZ '2026-01-01T00:00:00Z');
 IF value->>'kind'='date' THEN
  IF NOT(value ?& ARRAY['kind','date','zone','expression']) OR jsonb_typeof(value->'date')<>'string' OR (value->>'date')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
  date_text=(value->>'date')::date::text;RETURN date_text=value->>'date';
 END IF;
 IF NOT(value ?& ARRAY['kind','at','zone','expression']) OR jsonb_typeof(value->'at')<>'string' OR (value->>'at')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' THEN RETURN false; END IF;
 PERFORM (value->>'at')::timestamptz;
 RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE crm_ask_actions ADD CONSTRAINT crm_ask_action_due CHECK(crm_ask_action_due_valid(due));

CREATE FUNCTION invalidate_crm_ask_manual_copy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb=to_jsonb(OLD);new_row jsonb=to_jsonb(NEW);copy_kind text;copy_id text;changed boolean;erased boolean;action_id uuid;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'crm_selected_sources' THEN copy_kind='selected_note';copy_id=old_row->>'id';changed=jsonb_build_array(old_row->'availability',old_row->'revision',old_row->'content_hash') IS DISTINCT FROM jsonb_build_array(new_row->'availability',new_row->'revision',new_row->'content_hash');
 WHEN 'crm_mail_sources' THEN copy_kind='mail';copy_id=old_row->>'source_id';changed=jsonb_build_array(old_row->'availability',old_row->'source_revision',old_row->'content_hash') IS DISTINCT FROM jsonb_build_array(new_row->'availability',new_row->'source_revision',new_row->'content_hash');
 WHEN 'meeting_transcripts' THEN copy_kind='meeting_transcript';copy_id=old_row->>'id';changed=jsonb_build_array(old_row->'version',old_row->'utterances') IS DISTINCT FROM jsonb_build_array(new_row->'version',new_row->'utterances');
 WHEN 'call_transcripts' THEN copy_kind='call_transcript';copy_id=old_row->>'call_session_id';changed=jsonb_build_array(old_row->'crm_revision',old_row->'utterances') IS DISTINCT FROM jsonb_build_array(new_row->'crm_revision',new_row->'utterances');
 ELSE RAISE EXCEPTION 'Unknown manual action copy kind';
 END CASE;
 IF TG_OP='DELETE' OR changed THEN
  erased=TG_OP='DELETE' OR COALESCE(new_row->>'availability'='deleted',false);
  FOR action_id IN SELECT a.id FROM crm_ask_actions a WHERE a.workspace_id=OLD.workspace_id AND a.private_state='available' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.input_scope->'sources') src WHERE src->>'kind'=copy_kind AND src->>'sourceId'=copy_id) ORDER BY a.id FOR UPDATE LOOP
   UPDATE crm_ask_actions SET private_state=CASE WHEN erased THEN 'deleted' ELSE 'stale' END,target_firm_id=NULL,target_person_id=NULL,human_text=NULL,due=NULL,input_scope=NULL,initial_contexts=NULL,original_access_closure=NULL,support_refs=NULL,review_required=(kind='task' AND status='open'),version=version+1,updated_at=clock_timestamp() WHERE workspace_id=OLD.workspace_id AND id=action_id AND private_state='available';
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_manual_selected_invalidation AFTER UPDATE OR DELETE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_manual_copy();
CREATE TRIGGER crm_ask_manual_mail_invalidation AFTER UPDATE OR DELETE ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_manual_copy();
CREATE TRIGGER crm_ask_manual_meeting_invalidation AFTER UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_manual_copy();
CREATE TRIGGER crm_ask_manual_call_invalidation AFTER UPDATE OR DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_manual_copy();
