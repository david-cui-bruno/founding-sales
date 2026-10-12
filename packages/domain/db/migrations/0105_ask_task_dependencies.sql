-- changes: crm_ask_task_dependencies, crm_ask_requests, crm_ask_actions, crm_internal_tasks
-- Host-only independent task lineage. No source body, task label or model window.
CREATE TABLE crm_ask_task_dependencies (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),request_id uuid NOT NULL,
 request_version integer NOT NULL CHECK(request_version>0),request_epoch integer NOT NULL CHECK(request_epoch>0),
 action_id uuid,internal_task_id uuid,task_version integer NOT NULL CHECK(task_version>0),
 PRIMARY KEY(workspace_id,id),CHECK(num_nonnulls(action_id,internal_task_id)=1),
 UNIQUE(workspace_id,request_id,action_id),UNIQUE(workspace_id,request_id,internal_task_id),
 FOREIGN KEY(workspace_id,request_id) REFERENCES crm_ask_requests(workspace_id,id),
 FOREIGN KEY(workspace_id,action_id) REFERENCES crm_ask_actions(workspace_id,id),
 FOREIGN KEY(workspace_id,internal_task_id) REFERENCES crm_internal_tasks(workspace_id,id)
);
GRANT SELECT,INSERT,DELETE ON crm_ask_task_dependencies TO app_runtime,migration;
CREATE FUNCTION guard_crm_ask_task_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE consumer crm_ask_requests%ROWTYPE;
BEGIN
 SELECT * INTO consumer FROM crm_ask_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF consumer.execution_version<>'agent_v1' OR consumer.state<>'pending' OR consumer.cancelled_at IS NOT NULL OR consumer.version<>NEW.request_version OR consumer.epoch<>NEW.request_epoch
 OR (NEW.action_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crm_ask_actions a WHERE a.workspace_id=NEW.workspace_id AND a.id=NEW.action_id AND a.owner_user_id=consumer.owner_user_id AND a.kind='task' AND a.status='open' AND a.private_state='available' AND a.version=NEW.task_version))
 OR (NEW.internal_task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crm_internal_tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.internal_task_id AND t.owner_user_id=consumer.owner_user_id AND t.status='open' AND t.activation_receipt IS NOT NULL AND t.version=NEW.task_version))
 OR (SELECT count(*) FROM crm_ask_task_dependencies WHERE workspace_id=NEW.workspace_id AND request_id=NEW.request_id)>1000
 THEN RAISE EXCEPTION 'Task admission requires current pending owner-private evidence' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_ask_task_dependency_current AFTER INSERT ON crm_ask_task_dependencies DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION guard_crm_ask_task_dependency();
CREATE FUNCTION erase_crm_ask_task_dependencies() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('stale','deleted') OR NEW.question IS NULL THEN DELETE FROM crm_ask_task_dependencies WHERE workspace_id=NEW.workspace_id AND request_id=NEW.id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erase_crm_ask_task_dependencies AFTER UPDATE ON crm_ask_requests FOR EACH ROW EXECUTE FUNCTION erase_crm_ask_task_dependencies();
CREATE FUNCTION invalidate_crm_ask_task_consumers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='crm_ask_actions' THEN
  IF NEW.private_state='available' THEN RETURN NEW; END IF;
 ELSE
  IF NEW.activation_receipt IS NOT NULL AND NEW.activation_receipt IS NOT DISTINCT FROM OLD.activation_receipt AND NOT(NEW.review_required AND NOT OLD.review_required) THEN RETURN NEW; END IF;
 END IF;
 UPDATE crm_ask_requests SET state='stale',reason='source_changed',question=NULL,result=NULL,result_at=NULL,validated_progress=NULL,version=version+1,epoch=epoch+1,updated_at=clock_timestamp()
 WHERE workspace_id=NEW.workspace_id AND state NOT IN ('stale','deleted') AND id IN(SELECT request_id FROM crm_ask_task_dependencies WHERE workspace_id=NEW.workspace_id AND CASE WHEN TG_TABLE_NAME='crm_ask_actions' THEN action_id=NEW.id ELSE internal_task_id=NEW.id END);
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_crm_ask_action_consumers AFTER UPDATE ON crm_ask_actions FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_task_consumers();
CREATE TRIGGER invalidate_crm_ask_internal_task_consumers AFTER UPDATE ON crm_internal_tasks FOR EACH ROW EXECUTE FUNCTION invalidate_crm_ask_task_consumers();
-- Old copied task observations have no complete lineage (the displayed page may omit count contributors).
-- Erase them rather than inventing or backfilling missing authority.
UPDATE crm_ask_requests SET state='stale',reason='source_changed',question=NULL,result=NULL,result_at=NULL,validated_progress=NULL,version=version+1,epoch=epoch+1,updated_at=clock_timestamp()
 WHERE state NOT IN ('stale','deleted') AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(result->'exactResults',validated_progress->'exactResults','[]'::jsonb)) item WHERE item->>'operation'='tasks');
