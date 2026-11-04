-- changes: social_founder_inputs, social_founder_calibrations, social_draft_requests, social_private_drafts, workspace_memberships
CREATE TABLE social_founder_inputs (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 bullets text, context text, experience_date text, public_safe boolean NOT NULL DEFAULT false,
 reason text CHECK(reason IN ('removed','expired','owner_unavailable')),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '90 days',
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 days'),
 CHECK((reason IS NULL AND bullets IS NOT NULL AND length(btrim(bullets))>0 AND length(bullets)<=10000 AND octet_length(bullets)<=40000 AND context IS NOT NULL AND length(context)<=1000 AND octet_length(context)<=4000) OR (reason IS NOT NULL AND bullets IS NULL AND context IS NULL AND experience_date IS NULL AND NOT public_safe)),
 CHECK(reason IS NOT NULL OR (length(bullets)+length(context)<=10000 AND octet_length(bullets)+octet_length(context)<=40000)),
 CHECK(experience_date IS NULL OR experience_date ~ '^\d{4}-\d{2}-\d{2}$')
);
CREATE INDEX social_founder_input_expiry ON social_founder_inputs(expires_at) WHERE reason IS NULL;
CREATE FUNCTION valid_social_calibration_refs(refs jsonb,id_key text,required_count integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE ref jsonb; ids text[] := '{}';
BEGIN
 IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)<>required_count THEN RETURN false; END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(ref)<>'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(ref))<>2 OR NOT ref ?& ARRAY[id_key,'revision']
    OR jsonb_typeof(ref->id_key)<>'string' OR ref->>id_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(ref->'revision')<>'number' OR ref->>'revision' !~ '^[1-9][0-9]{0,9}$'
    OR lower(ref->>id_key)=ANY(ids) THEN RETURN false; END IF;
  ids:=array_append(ids,lower(ref->>id_key));
 END LOOP;
 RETURN true;
END $$;
CREATE TABLE social_founder_calibrations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 examples jsonb NOT NULL CHECK(valid_social_calibration_refs(examples,'draftId',3)),
 guide_ref jsonb CHECK(guide_ref IS NULL OR valid_social_calibration_refs(jsonb_build_array(guide_ref),'guideId',1)),
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,owner_user_id), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_founder_inputs,social_founder_calibrations TO app_runtime,migration;
CREATE FUNCTION fence_social_founder_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.revision<>OLD.revision+1 OR OLD.reason IS NOT NULL THEN RAISE EXCEPTION 'social_founder_input_terminal_or_invalid_revision'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_founder_input_fence BEFORE UPDATE ON social_founder_inputs FOR EACH ROW EXECUTE FUNCTION fence_social_founder_input();
CREATE FUNCTION erase_social_founder_input_outputs(p_workspace uuid,p_owner uuid,p_input uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE social_draft_requests SET concepts=NULL,state=CASE WHEN state IN ('queued','calling','ready') THEN 'review' ELSE state END,reason='source_changed_or_unavailable',updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND owner_user_id=p_owner AND source_selection->'founderInputRefs' @> jsonb_build_array(jsonb_build_object('inputId',p_input::text));
 UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND owner_user_id=p_owner AND reason IS NULL AND dependencies->'social_founder_inputs' ? p_input::text;
END $$;
CREATE FUNCTION erase_changed_social_founder_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM erase_social_founder_input_outputs(OLD.workspace_id,OLD.owner_user_id,OLD.id);
 RETURN NULL;
END $$;
CREATE TRIGGER social_founder_input_changed AFTER UPDATE OR DELETE ON social_founder_inputs FOR EACH ROW EXECUTE FUNCTION erase_changed_social_founder_input();
CREATE FUNCTION erase_departed_social_founder_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.status IS DISTINCT FROM 'active' THEN
  UPDATE social_founder_inputs SET bullets=NULL,context=NULL,experience_date=NULL,public_safe=false,reason='owner_unavailable',revision=revision+1 WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id AND reason IS NULL;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_founder_owner_departure BEFORE UPDATE OF status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION erase_departed_social_founder_owner();
