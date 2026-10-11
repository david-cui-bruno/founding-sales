-- changes: crm_mail_thread_expansions, crm_mail_import_allocations, crm_mail_import_read_reservations, crm_business_policies, crm_mail_import_messages
ALTER TABLE crm_business_policies ADD COLUMN qualification_version text NOT NULL DEFAULT 'business-metadata-unclassified-v1' CHECK(qualification_version IN ('business-metadata-unclassified-v1','business-metadata-qualified-v2'));
ALTER TABLE crm_business_policies ALTER COLUMN qualification_version SET DEFAULT 'business-metadata-qualified-v2';
-- Independent older-context coverage. No existing import receives invented completion.
ALTER TABLE crm_mail_import_allocations ADD COLUMN thread_units integer NOT NULL DEFAULT 10 CHECK(thread_units=10);
ALTER TABLE crm_mail_import_read_reservations DROP CONSTRAINT crm_mail_import_read_reservations_method_check;
ALTER TABLE crm_mail_import_read_reservations ADD CHECK(method IN ('profile','list','history','metadata','body','thread'));
CREATE TABLE crm_mail_thread_expansions (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 import_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 decision_revision integer NOT NULL CHECK(decision_revision>=0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','enumerating','complete','partial','blocked','deleted')),
 reason text,
 enumeration_complete boolean NOT NULL DEFAULT false,
 message_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(message_ids)='array' AND jsonb_array_length(message_ids)<=500),
 next_ordinal integer NOT NULL DEFAULT 0 CHECK(next_ordinal>=0 AND next_ordinal<=500),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,import_id,conversation_id,decision_revision),
 FOREIGN KEY(workspace_id,import_id) REFERENCES crm_mail_imports(workspace_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES crm_business_conversations(workspace_id,id)
);
CREATE INDEX crm_mail_thread_expansion_pending ON crm_mail_thread_expansions(workspace_id,import_id,state,id);
GRANT SELECT,INSERT,UPDATE ON crm_mail_thread_expansions TO app_runtime;
ALTER TABLE crm_mail_import_messages DROP CONSTRAINT crm_mail_import_messages_scope_check;
ALTER TABLE crm_mail_import_messages ADD CHECK(scope IN ('historical','overlap','reconciliation','expanded'));
CREATE FUNCTION crm_redact_deleted_thread_expansions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.metadata_availability='deleted' THEN
  UPDATE crm_mail_thread_expansions SET state='deleted',reason='metadata_deleted',message_ids='[]',next_ordinal=0,revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND conversation_id=NEW.id AND state<>'deleted';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_redact_deleted_thread_expansions AFTER UPDATE OF metadata_availability ON crm_business_conversations FOR EACH ROW EXECUTE FUNCTION crm_redact_deleted_thread_expansions();
CREATE FUNCTION crm_thread_expansion_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.import_id<>OLD.import_id OR NEW.conversation_id<>OLD.conversation_id OR NEW.decision_revision<>OLD.decision_revision OR NEW.revision<>OLD.revision+1 THEN
  RAISE EXCEPTION 'Expansion binding is immutable' USING ERRCODE='23514',CONSTRAINT='crm_thread_expansion_immutable';
 END IF;
 IF NEW.state='deleted' THEN
  IF NEW.message_ids<>'[]'::jsonb OR NEW.next_ordinal<>0 THEN RAISE EXCEPTION 'Deleted expansion retains identities' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.state IN ('complete','partial','blocked','deleted') OR
    (OLD.state='pending' AND NEW.state NOT IN ('enumerating','blocked')) OR
    (OLD.state='enumerating' AND NEW.state NOT IN ('enumerating','complete','partial','blocked')) OR
    NEW.next_ordinal<OLD.next_ordinal OR NEW.next_ordinal>OLD.next_ordinal+1 OR
    NEW.next_ordinal>jsonb_array_length(NEW.message_ids) OR
    (OLD.state='enumerating' AND NEW.message_ids<>OLD.message_ids) OR
    (NEW.state IN ('complete','partial') AND NEW.next_ordinal<>jsonb_array_length(NEW.message_ids)) OR
    (NEW.state='complete' AND NOT NEW.enumeration_complete) THEN
  RAISE EXCEPTION 'Expansion progress must be conserved' USING ERRCODE='23514',CONSTRAINT='crm_thread_expansion_monotonic';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_thread_expansion_fence BEFORE UPDATE ON crm_mail_thread_expansions FOR EACH ROW EXECUTE FUNCTION crm_thread_expansion_fence();
