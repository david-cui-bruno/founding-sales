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
 kind text NOT NULL CHECK(kind IN ('task','note','preference')),
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
