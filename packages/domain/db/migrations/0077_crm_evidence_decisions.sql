-- ACL provenance is separate from inferred/extracted subject context.
CREATE FUNCTION crm_access_closure_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE key text;ids jsonb;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(value))<>2 OR NOT(value ? 'firmIds' AND value ? 'personIds') THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['firmIds','personIds'] LOOP
  ids=value->key;
  IF jsonb_typeof(ids)<>'array' THEN RETURN false; END IF;
  IF jsonb_array_length(ids)>100 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(ids) id WHERE jsonb_typeof(id)<>'string' OR (id#>>'{}') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
  IF ids IS DISTINCT FROM COALESCE((SELECT jsonb_agg(DISTINCT id ORDER BY id) FROM jsonb_array_elements_text(ids) id),'[]'::jsonb) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE crm_selected_sources ADD COLUMN original_access_closure jsonb CONSTRAINT crm_selected_original_access_closure CHECK(original_access_closure IS NULL OR crm_access_closure_valid(original_access_closure));
CREATE FUNCTION capture_crm_selected_access_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb;firms jsonb;people jsonb;
BEGIN
 IF TG_OP='INSERT' THEN prior='{"firmIds":[],"personIds":[]}'::jsonb;
 ELSE
   IF NOT(OLD.availability<>'available' AND NEW.availability='available') THEN
     IF NEW.original_access_closure IS DISTINCT FROM OLD.original_access_closure THEN RAISE EXCEPTION 'Original copied authority is immutable' USING ERRCODE='23514',CONSTRAINT='crm_selected_original_access_immutable'; END IF;
     RETURN NEW;
   END IF;
   prior=COALESCE(OLD.original_access_closure,'{"firmIds":[],"personIds":[]}'::jsonb);
 END IF;
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO firms FROM (
   SELECT jsonb_array_elements_text(prior->'firmIds') id
   UNION SELECT NEW.firm_id::text WHERE NEW.firm_id IS NOT NULL
   UNION SELECT cx.firm_id::text FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id
   UNION SELECT c.firm_id::text FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id
     WHERE b.workspace_id=NEW.workspace_id AND b.person_id=NEW.person_id AND NOT EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id)
 ) selected;
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO people FROM (
   SELECT jsonb_array_elements_text(prior->'personIds') id
   UNION SELECT NEW.person_id::text WHERE NEW.person_id IS NOT NULL
   UNION SELECT cx.person_id::text FROM crm_source_relationship_contexts cx WHERE cx.workspace_id=NEW.workspace_id AND cx.source_id=NEW.id
 ) selected;
 NEW.original_access_closure=jsonb_build_object('firmIds',firms,'personIds',people);
 RETURN NEW;
END $$;
CREATE TRIGGER crm_selected_original_access_capture BEFORE INSERT OR UPDATE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION capture_crm_selected_access_closure();

-- Source-bound equality and decisions are independent of disposable model claims.
CREATE TABLE crm_claim_review_anchors (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 source_kind text NOT NULL CHECK(source_kind IN ('selected_note','mail','call_transcript','meeting_transcript')),
 source_id uuid NOT NULL,source_revision integer NOT NULL CHECK(source_revision>0),source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 owner_user_id uuid NOT NULL,context_snapshot jsonb NOT NULL CHECK(crm_extraction_context_valid(context_snapshot)),
 original_access_closure jsonb NOT NULL CONSTRAINT crm_claim_anchor_original_access_closure CHECK(crm_access_closure_valid(original_access_closure)),
 context_hash text NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),semantic_hash text NOT NULL CHECK(semantic_hash ~ '^[a-f0-9]{64}$'),
 review_family_hash text NOT NULL CHECK(review_family_hash ~ '^[a-f0-9]{64}$'),claim_kind text NOT NULL CHECK(claim_kind IN ('need','objection','commitment')),
 locator_hash text NOT NULL CHECK(locator_hash ~ '^[a-f0-9]{64}$'),original_claim_id uuid NOT NULL,original_claim_hash text NOT NULL CHECK(original_claim_hash ~ '^[a-f0-9]{64}$'),
 original_claim_revision integer NOT NULL CHECK(original_claim_revision=1),current_decision_revision integer NOT NULL DEFAULT 0 CHECK(current_decision_revision>=0),
 original_event_at timestamptz,original_observed_at timestamptz,
 availability text NOT NULL DEFAULT 'available' CHECK(availability IN ('available','deleted')),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((availability='available' AND original_observed_at IS NOT NULL) OR (availability='deleted' AND original_event_at IS NULL AND original_observed_at IS NULL)),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,semantic_hash),FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE FUNCTION crm_claim_anchor_original_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.source_kind,NEW.source_id,NEW.source_revision,NEW.source_hash,NEW.owner_user_id,NEW.context_snapshot,NEW.original_access_closure,NEW.context_hash,NEW.semantic_hash,NEW.review_family_hash,NEW.claim_kind,NEW.locator_hash,NEW.original_claim_id,NEW.original_claim_hash,NEW.original_claim_revision,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.source_kind,OLD.source_id,OLD.source_revision,OLD.source_hash,OLD.owner_user_id,OLD.context_snapshot,OLD.original_access_closure,OLD.context_hash,OLD.semantic_hash,OLD.review_family_hash,OLD.claim_kind,OLD.locator_hash,OLD.original_claim_id,OLD.original_claim_hash,OLD.original_claim_revision,OLD.created_at)
 OR OLD.availability='deleted' AND NEW.availability<>'deleted'
 OR ROW(NEW.original_event_at,NEW.original_observed_at) IS DISTINCT FROM ROW(OLD.original_event_at,OLD.original_observed_at) AND NOT(NEW.availability='deleted' AND NEW.original_event_at IS NULL AND NEW.original_observed_at IS NULL)
 THEN RAISE EXCEPTION 'Original evidence identity and capture authority are immutable' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_claim_anchor_original_immutable AFTER UPDATE ON crm_claim_review_anchors DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_claim_anchor_original_immutable();
CREATE INDEX crm_claim_review_source ON crm_claim_review_anchors(workspace_id,source_kind,source_id,source_revision);
CREATE TABLE crm_claim_decision_revisions (
 workspace_id uuid NOT NULL,anchor_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('confirm','dismiss','correct')),actor_user_id uuid NOT NULL,decision_at timestamptz NOT NULL DEFAULT now(),
 corrected_interpretation text CHECK(length(btrim(corrected_interpretation)) BETWEEN 1 AND 1000),rationale text CHECK(length(btrim(rationale)) BETWEEN 1 AND 1000),redacted_at timestamptz,
 PRIMARY KEY(workspace_id,anchor_id,revision),FOREIGN KEY(workspace_id,anchor_id) REFERENCES crm_claim_review_anchors(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((redacted_at IS NOT NULL AND corrected_interpretation IS NULL AND rationale IS NULL) OR (redacted_at IS NULL AND (action='correct')=(corrected_interpretation IS NOT NULL)))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_claim_review_anchors,crm_claim_decision_revisions TO app_runtime,migration;

CREATE TABLE crm_claim_conflicts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),current_revision integer NOT NULL CHECK(current_revision>0),
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE crm_claim_conflict_revisions (
 workspace_id uuid NOT NULL,conflict_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('open','resolved')),resolution text CHECK(resolution IN ('keep_both','prefer_claim')),
 preferred_anchor_id uuid,actor_user_id uuid NOT NULL,decided_at timestamptz NOT NULL DEFAULT now(),rationale text CHECK(length(btrim(rationale)) BETWEEN 1 AND 1000),redacted_at timestamptz,
 PRIMARY KEY(workspace_id,conflict_id,revision),FOREIGN KEY(workspace_id,conflict_id) REFERENCES crm_claim_conflicts(workspace_id,id),
 FOREIGN KEY(workspace_id,preferred_anchor_id) REFERENCES crm_claim_review_anchors(workspace_id,id),FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT crm_claim_conflict_revisions_state_shape CHECK((state='open' AND resolution IS NULL AND preferred_anchor_id IS NULL) OR (state='resolved' AND resolution IS NOT NULL AND (resolution='prefer_claim')=(preferred_anchor_id IS NOT NULL))),
 CONSTRAINT crm_claim_conflict_revisions_redaction_shape CHECK(redacted_at IS NULL OR rationale IS NULL)
);
CREATE TABLE crm_claim_conflict_members (
 workspace_id uuid NOT NULL,conflict_id uuid NOT NULL,revision integer NOT NULL,anchor_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,conflict_id,revision,anchor_id),FOREIGN KEY(workspace_id,conflict_id,revision) REFERENCES crm_claim_conflict_revisions(workspace_id,conflict_id,revision),
 FOREIGN KEY(workspace_id,anchor_id) REFERENCES crm_claim_review_anchors(workspace_id,id)
);
CREATE FUNCTION crm_claim_conflict_members_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ws uuid;identity uuid;rev integer;total integer;preferred uuid;
BEGIN
 ws:=coalesce(NEW.workspace_id,OLD.workspace_id);identity:=coalesce(NEW.conflict_id,OLD.conflict_id);rev:=coalesce(NEW.revision,OLD.revision);
 IF NOT EXISTS(SELECT 1 FROM crm_claim_conflict_revisions WHERE workspace_id=ws AND conflict_id=identity AND revision=rev) THEN RETURN NULL; END IF;
 SELECT count(*) INTO total FROM crm_claim_conflict_members WHERE workspace_id=ws AND conflict_id=identity AND revision=rev;
 SELECT preferred_anchor_id INTO preferred FROM crm_claim_conflict_revisions WHERE workspace_id=ws AND conflict_id=identity AND revision=rev;
 IF total<2 OR total>10 OR preferred IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crm_claim_conflict_members WHERE workspace_id=ws AND conflict_id=identity AND revision=rev AND anchor_id=preferred) THEN
 RAISE EXCEPTION 'Conflict requires two to ten distinct members and an actual preferred member' USING ERRCODE='23514', CONSTRAINT=TG_NAME; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_claim_conflict_revision_members AFTER INSERT OR UPDATE ON crm_claim_conflict_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_claim_conflict_members_valid();
CREATE CONSTRAINT TRIGGER crm_claim_conflict_members_shape AFTER INSERT OR UPDATE OR DELETE ON crm_claim_conflict_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_claim_conflict_members_valid();
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_claim_conflicts,crm_claim_conflict_revisions,crm_claim_conflict_members TO app_runtime,migration;

-- Dated human revisions and complete conflict membership are append-only. Only
-- explicit source/identity deletion may clear their copied text.
CREATE FUNCTION crm_claim_human_revision_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE text_columns text[];deleted_basis boolean;
BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME='crm_claim_conflict_members' THEN
  RAISE EXCEPTION 'Human revision history is append-only' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
 END IF;
 IF TG_TABLE_NAME='crm_claim_decision_revisions' THEN
  text_columns=ARRAY['corrected_interpretation','rationale','redacted_at'];
  SELECT availability='deleted' INTO deleted_basis FROM crm_claim_review_anchors WHERE workspace_id=NEW.workspace_id AND id=NEW.anchor_id;
 ELSE
  text_columns=ARRAY['rationale','redacted_at'];
  SELECT EXISTS(SELECT 1 FROM crm_claim_conflict_members m JOIN crm_claim_review_anchors a ON a.workspace_id=m.workspace_id AND a.id=m.anchor_id WHERE m.workspace_id=NEW.workspace_id AND m.conflict_id=NEW.conflict_id AND a.availability='deleted') INTO deleted_basis;
 END IF;
 IF to_jsonb(NEW)-text_columns IS DISTINCT FROM to_jsonb(OLD)-text_columns
 OR NOT deleted_basis OR NEW.redacted_at IS NULL OR NEW.rationale IS NOT NULL
 OR (TG_TABLE_NAME='crm_claim_decision_revisions' AND to_jsonb(NEW)->>'corrected_interpretation' IS NOT NULL)
 THEN RAISE EXCEPTION 'Human revision history is append-only except deletion redaction' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER crm_claim_decision_append_only AFTER UPDATE OR DELETE ON crm_claim_decision_revisions DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_claim_human_revision_append_only();
CREATE CONSTRAINT TRIGGER crm_claim_conflict_revision_append_only AFTER UPDATE OR DELETE ON crm_claim_conflict_revisions DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_claim_human_revision_append_only();
CREATE CONSTRAINT TRIGGER crm_claim_conflict_member_append_only AFTER UPDATE OR DELETE ON crm_claim_conflict_members DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION crm_claim_human_revision_append_only();
REVOKE DELETE,TRUNCATE ON crm_claim_review_anchors,crm_claim_decision_revisions,crm_claim_conflicts,crm_claim_conflict_revisions,crm_claim_conflict_members FROM app_runtime,migration;

CREATE FUNCTION redact_crm_human_source(ws uuid,kind text,identity uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE crm_claim_review_anchors SET availability='deleted',original_event_at=NULL,original_observed_at=NULL WHERE workspace_id=ws AND source_kind=kind AND source_id=identity;
 PERFORM flag_crm_open_human_work(ws,ARRAY(SELECT id FROM crm_claim_review_anchors WHERE workspace_id=ws AND source_kind=kind AND source_id=identity),'source_deleted');
 UPDATE crm_claim_decision_revisions d SET corrected_interpretation=NULL,rationale=NULL,redacted_at=coalesce(d.redacted_at,now())
 FROM crm_claim_review_anchors a WHERE a.workspace_id=ws AND a.source_kind=kind AND a.source_id=identity AND d.workspace_id=a.workspace_id AND d.anchor_id=a.id;
 UPDATE crm_claim_conflict_revisions r SET rationale=NULL,redacted_at=coalesce(r.redacted_at,now()) WHERE r.workspace_id=ws AND EXISTS(SELECT 1 FROM crm_claim_conflict_members m JOIN crm_claim_review_anchors a ON a.workspace_id=m.workspace_id AND a.id=m.anchor_id WHERE m.workspace_id=r.workspace_id AND m.conflict_id=r.conflict_id AND a.source_kind=kind AND a.source_id=identity);
END $$;
CREATE FUNCTION redact_crm_selected_human_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.availability='deleted' THEN PERFORM redact_crm_human_source(OLD.workspace_id,'selected_note',OLD.id); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_selected_human_redaction AFTER UPDATE OR DELETE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION redact_crm_selected_human_decisions();

CREATE FUNCTION redact_crm_mail_human_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.availability='deleted' THEN PERFORM redact_crm_human_source(OLD.workspace_id,'mail',OLD.source_id); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_mail_human_redaction AFTER UPDATE OR DELETE ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION redact_crm_mail_human_decisions();

CREATE TABLE crm_claim_work_dependencies (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),work_kind text NOT NULL CHECK(work_kind IN ('call_task','meeting_task')),work_id uuid NOT NULL,anchor_id uuid NOT NULL,
 observed_work_version text NOT NULL CHECK(length(observed_work_version) BETWEEN 1 AND 40),observed_decision_revision integer NOT NULL CHECK(observed_decision_revision>=0),
 review_required boolean NOT NULL DEFAULT false,review_reason text CHECK(review_reason IN ('human_decision_changed','conflict_changed','source_changed','source_deleted','material_claim_changed')),
 invalidation_revision integer NOT NULL DEFAULT 1 CHECK(invalidation_revision>0),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,work_kind,work_id,anchor_id),FOREIGN KEY(workspace_id,anchor_id) REFERENCES crm_claim_review_anchors(workspace_id,id),
 CHECK(review_required=(review_reason IS NOT NULL))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_claim_work_dependencies TO app_runtime,migration;
CREATE FUNCTION flag_crm_open_human_work(ws uuid,anchors uuid[],reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE crm_claim_work_dependencies d SET review_required=true,review_reason=reason,invalidation_revision=invalidation_revision+1
 WHERE d.workspace_id=ws AND d.anchor_id=ANY(anchors) AND (
 (d.work_kind='call_task' AND EXISTS(SELECT 1 FROM call_tasks t WHERE t.workspace_id=d.workspace_id AND t.id=d.work_id AND t.status='open')) OR
 (d.work_kind='meeting_task' AND EXISTS(SELECT 1 FROM meeting_tasks t WHERE t.workspace_id=d.workspace_id AND t.id=d.work_id AND t.status='open')));
END $$;
CREATE FUNCTION flag_crm_human_decision_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM flag_crm_open_human_work(NEW.workspace_id,ARRAY[NEW.anchor_id],'human_decision_changed');
 RETURN NEW;
END $$;
CREATE TRIGGER crm_human_decision_work_invalidation AFTER INSERT ON crm_claim_decision_revisions FOR EACH ROW EXECUTE FUNCTION flag_crm_human_decision_work();

CREATE FUNCTION redact_crm_native_human_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF TG_TABLE_NAME='call_transcripts' THEN
     PERFORM redact_crm_human_source(OLD.workspace_id,'call_transcript',OLD.call_session_id);
   ELSE
     PERFORM redact_crm_human_source(OLD.workspace_id,'meeting_transcript',OLD.id);
   END IF;
   RETURN OLD;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_call_human_redaction AFTER DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION redact_crm_native_human_decisions();
CREATE TRIGGER crm_meeting_human_redaction AFTER DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION redact_crm_native_human_decisions();
