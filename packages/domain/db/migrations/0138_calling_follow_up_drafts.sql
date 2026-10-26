-- changes: calling_follow_up_drafts
-- Current private preparation only, never a recipient, permission or outbound fence.
CREATE FUNCTION calling_follow_up_content_valid(c jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; prose text; units integer;
BEGIN
 IF c IS NULL OR jsonb_typeof(c) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(c))<>2 OR NOT c ?& ARRAY['subject','body'] THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['subject','body'] LOOP
  IF jsonb_typeof(c->k) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  prose:=c->>k;
  IF btrim(prose,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=''
   OR octet_length(prose)>(CASE WHEN k='subject' THEN 640 ELSE 16000 END) THEN RETURN false; END IF;
  SELECT COALESCE(sum(CASE WHEN octet_length(ch)>3 THEN 2 ELSE 1 END),0) INTO units FROM regexp_split_to_table(prose,'') ch;
  IF units>(CASE WHEN k='subject' THEN 160 ELSE 4000 END) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Composite source witnesses enforce exact same-workspace/source association.
CREATE UNIQUE INDEX calling_attempt_source_key ON sourcing_manual_prospect_attempts(workspace_id,id,candidate_id,candidate_revision);
CREATE UNIQUE INDEX calling_log_source_key ON call_logs(workspace_id,id,firm_id);
CREATE TABLE calling_follow_up_drafts (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 creator_user_id uuid NOT NULL,
 creator_ref uuid,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 source_kind text NOT NULL CHECK(source_kind IN ('candidate','firm')),
 candidate_id uuid,
 candidate_revision integer CHECK(candidate_revision>0),
 attempt_id uuid,
 attempt_ref uuid,
 firm_id uuid,
 call_log_id uuid,
 call_log_ref uuid,
 content jsonb,
 reason text CHECK(reason IN ('withdrawn','source_changed_or_unavailable','source_revision_changed','removed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,creator_ref) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE SET NULL (creator_ref),
 FOREIGN KEY(workspace_id,attempt_ref,candidate_id,candidate_revision) REFERENCES sourcing_manual_prospect_attempts(workspace_id,id,candidate_id,candidate_revision) ON DELETE SET NULL (attempt_ref),
 FOREIGN KEY(workspace_id,call_log_ref,firm_id) REFERENCES call_logs(workspace_id,id,firm_id) ON DELETE SET NULL (call_log_ref),
 CONSTRAINT calling_draft_source_shape CHECK(
  (source_kind='candidate' AND candidate_id IS NOT NULL AND candidate_revision IS NOT NULL AND attempt_id IS NOT NULL AND firm_id IS NULL AND call_log_id IS NULL AND call_log_ref IS NULL)
  OR (source_kind='firm' AND firm_id IS NOT NULL AND call_log_id IS NOT NULL AND candidate_id IS NULL AND candidate_revision IS NULL AND attempt_id IS NULL AND attempt_ref IS NULL)),
 CONSTRAINT calling_draft_content_shape CHECK(
  (content IS NULL AND reason IS NOT NULL) OR
  (content IS NOT NULL AND reason IS NULL AND calling_follow_up_content_valid(content) AND creator_ref=creator_user_id AND creator_ref IS NOT NULL
   AND ((source_kind='candidate' AND attempt_ref=attempt_id AND attempt_ref IS NOT NULL) OR (source_kind='firm' AND call_log_ref=call_log_id AND call_log_ref IS NOT NULL)))),
 CHECK(updated_at>=created_at)
);
CREATE UNIQUE INDEX calling_draft_attempt_once ON calling_follow_up_drafts(workspace_id,attempt_id) WHERE source_kind='candidate';
CREATE UNIQUE INDEX calling_draft_call_once ON calling_follow_up_drafts(workspace_id,call_log_id) WHERE source_kind='firm';
CREATE INDEX calling_draft_creator_page ON calling_follow_up_drafts(workspace_id,creator_user_id,id);
CREATE FUNCTION calling_draft_current_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.creator_user_id,NEW.source_kind,NEW.candidate_id,NEW.candidate_revision,NEW.attempt_id,NEW.firm_id,NEW.call_log_id,NEW.created_at)
 IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.creator_user_id,OLD.source_kind,OLD.candidate_id,OLD.candidate_revision,OLD.attempt_id,OLD.firm_id,OLD.call_log_id,OLD.created_at)
 OR NEW.revision<>OLD.revision+1 OR (OLD.content IS NULL AND NEW.content IS NOT NULL) THEN
  RAISE EXCEPTION 'calling draft identity or terminal fence' USING ERRCODE='23514';
 END IF;
 -- FK deletion may clear only its witness, never substitute another source/creator.
 IF (NEW.creator_ref IS NOT NULL AND NEW.creator_ref IS DISTINCT FROM OLD.creator_ref)
 OR (NEW.attempt_ref IS NOT NULL AND NEW.attempt_ref IS DISTINCT FROM OLD.attempt_ref)
 OR (NEW.call_log_ref IS NOT NULL AND NEW.call_log_ref IS DISTINCT FROM OLD.call_log_ref) THEN
  RAISE EXCEPTION 'calling draft source witness changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_draft_current_only BEFORE UPDATE ON calling_follow_up_drafts FOR EACH ROW EXECUTE FUNCTION calling_draft_current_only();
CREATE FUNCTION calling_draft_source_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
 why:=CASE WHEN TG_OP='DELETE' THEN 'removed' ELSE 'source_changed_or_unavailable' END;
 IF TG_TABLE_NAME='sourcing_manual_prospect_attempts' THEN
  IF TG_OP='UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.reason='candidate_revision_changed' THEN why:='source_revision_changed'; END IF;
  UPDATE calling_follow_up_drafts SET content=NULL,reason=why,revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND attempt_id=OLD.id AND content IS NOT NULL;
 ELSIF TG_TABLE_NAME='call_logs' THEN
  UPDATE calling_follow_up_drafts SET content=NULL,reason=why,revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND call_log_id=OLD.id AND content IS NOT NULL;
 ELSIF TG_TABLE_NAME='firms' THEN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.assigned_user_id IS NOT DISTINCT FROM OLD.assigned_user_id THEN RETURN NEW; END IF;
  UPDATE calling_follow_up_drafts SET content=NULL,reason=why,revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND firm_id=OLD.id AND content IS NOT NULL;
 ELSE
  IF TG_OP='UPDATE' AND NEW.status='active' AND NEW.role IS NOT DISTINCT FROM OLD.role THEN RETURN NEW; END IF;
  UPDATE calling_follow_up_drafts SET content=NULL,reason='removed',revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND creator_user_id=OLD.user_id AND content IS NOT NULL;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
-- Propagate existing source-loss and retention erasure, without a second source engine.
CREATE TRIGGER calling_draft_activity_erasure BEFORE UPDATE OR DELETE ON sourcing_manual_prospect_attempts FOR EACH ROW EXECUTE FUNCTION calling_draft_source_erasure();
CREATE TRIGGER calling_draft_call_erasure BEFORE UPDATE OF outcome,note,firm_id,contact_id OR DELETE ON call_logs FOR EACH ROW EXECUTE FUNCTION calling_draft_source_erasure();
CREATE TRIGGER calling_draft_firm_erasure BEFORE UPDATE OF status,assigned_user_id OR DELETE ON firms FOR EACH ROW EXECUTE FUNCTION calling_draft_source_erasure();
CREATE TRIGGER calling_draft_creator_erasure BEFORE UPDATE OF status,role OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION calling_draft_source_erasure();
-- FK SET NULL updates also advance the terminal fence revision.
CREATE FUNCTION calling_draft_witness_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.creator_ref,NEW.attempt_ref,NEW.call_log_ref) IS DISTINCT FROM (OLD.creator_ref,OLD.attempt_ref,OLD.call_log_ref)
  AND NEW.revision=OLD.revision THEN NEW.revision:=OLD.revision+1; NEW.updated_at:=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_draft_0_witness_erasure BEFORE UPDATE ON calling_follow_up_drafts FOR EACH ROW EXECUTE FUNCTION calling_draft_witness_erasure();
GRANT SELECT,INSERT,UPDATE ON calling_follow_up_drafts TO app_runtime,migration;
-- Opaque terminal identities cannot be deleted and reminted by application code.
REVOKE DELETE,TRUNCATE ON calling_follow_up_drafts FROM app_runtime;
