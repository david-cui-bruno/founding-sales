-- changes: crm_ask_requests, crm_ask_sessions, crm_ask_session_turns, crm_ask_actions
-- #558 private sessions reference existing erasure-covered requests; no duplicate source bodies.
CREATE TABLE crm_ask_sessions (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),scope jsonb,title text CHECK(title IS NULL OR length(btrim(title)) BETWEEN 1 AND 100),
 pinned boolean NOT NULL DEFAULT false,state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_ask_sessions_valid_shape CHECK((state='active' AND scope IS NOT NULL AND jsonb_typeof(scope)='object') OR (state='deleted' AND scope IS NULL AND title IS NULL AND NOT pinned))
);
CREATE TABLE crm_ask_session_turns (
 workspace_id uuid NOT NULL,session_id uuid NOT NULL,request_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 50),
 PRIMARY KEY(workspace_id,session_id,ordinal),UNIQUE(workspace_id,request_id),
 FOREIGN KEY(workspace_id,session_id) REFERENCES crm_ask_sessions(workspace_id,id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id)
);
CREATE INDEX crm_ask_sessions_owner ON crm_ask_sessions(workspace_id,owner_user_id,pinned DESC,updated_at DESC,id);
GRANT SELECT,INSERT,UPDATE ON crm_ask_sessions TO app_runtime,migration;
GRANT SELECT,INSERT ON crm_ask_session_turns TO app_runtime,migration;
CREATE FUNCTION crm_ask_session_turn_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM crm_ask_sessions WHERE workspace_id=NEW.workspace_id AND id=NEW.session_id) AND EXISTS(SELECT 1 FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id) AND NOT EXISTS(SELECT 1 FROM crm_ask_sessions s JOIN crm_ask_requests r ON r.workspace_id=s.workspace_id AND r.owner_user_id=s.owner_user_id WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.session_id AND s.state='active' AND r.id=NEW.request_id AND r.question IS NOT NULL AND r.state NOT IN ('stale','deleted')) THEN
 RAISE EXCEPTION 'Session turns bind a current owner-private request' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_session_turn_guard BEFORE INSERT ON crm_ask_session_turns FOR EACH ROW EXECUTE FUNCTION crm_ask_session_turn_guard();
CREATE FUNCTION crm_ask_session_erase_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.question IS NULL OR NEW.state IN ('stale','deleted') THEN
  UPDATE crm_ask_sessions SET title=NULL,pinned=false,version=version+1,updated_at=clock_timestamp()
   WHERE workspace_id=NEW.workspace_id AND id IN(SELECT session_id FROM crm_ask_session_turns WHERE workspace_id=NEW.workspace_id AND request_id=NEW.id) AND (title IS NOT NULL OR pinned);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_session_erase_title AFTER UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION crm_ask_session_erase_title();

-- Optional explicitly selected initiative is part of immutable human action proof.
ALTER TABLE crm_ask_actions ADD COLUMN target_opportunity_id uuid;
ALTER TABLE crm_ask_actions ADD CONSTRAINT crm_ask_action_opportunity_fkey FOREIGN KEY(workspace_id,target_opportunity_id,target_firm_id) REFERENCES opportunities(workspace_id,id,firm_id);
ALTER TABLE crm_ask_actions ADD CONSTRAINT crm_ask_action_opportunity_shape CHECK(target_opportunity_id IS NULL OR (private_state='available' AND kind IN ('note','task') AND target_firm_id IS NOT NULL AND target_person_id IS NULL));
CREATE FUNCTION crm_ask_action_opportunity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.private_state='available' AND NEW.target_opportunity_id IS DISTINCT FROM OLD.target_opportunity_id THEN
 RAISE EXCEPTION 'Selected opportunity is immutable action proof' USING ERRCODE='23514',CONSTRAINT='crm_ask_action_opportunity_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_action_opportunity_immutable AFTER UPDATE ON crm_ask_actions DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_ask_action_opportunity_guard();
CREATE FUNCTION crm_ask_action_opportunity_clear() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.private_state<>'available' THEN NEW.target_opportunity_id=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_ask_action_opportunity_clear BEFORE UPDATE ON crm_ask_actions FOR EACH ROW EXECUTE FUNCTION crm_ask_action_opportunity_clear();
