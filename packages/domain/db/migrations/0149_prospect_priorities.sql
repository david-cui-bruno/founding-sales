-- changes: sourcing_prospect_priorities, sourcing_prospect_considerations
-- Private human assessments and minimal consideration context. Never execution authority.
CREATE FUNCTION valid_prospect_priority_roles(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb;
BEGIN
 IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v)>8 THEN RETURN false;END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(v) LOOP
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>5
   OR NOT r ?& ARRAY['personId','relationshipId','relationshipRevision','role','basis']
   OR jsonb_typeof(r->'personId') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'relationshipId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(r->'relationshipRevision') IS DISTINCT FROM 'number' OR (r->>'relationshipRevision') !~ '^[1-9][0-9]{0,8}$'
   OR jsonb_typeof(r->'basis') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'role') IS DISTINCT FROM 'string'
   OR r->>'basis' NOT IN ('hypothesis','source_supported','directly_confirmed')
   OR r->>'role' NOT IN ('workflow_owner','budget_approver','advocate','implementation') THEN RETURN false;END IF;
  PERFORM (r->>'personId')::uuid,(r->>'relationshipId')::uuid;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE sourcing_prospect_priorities (
 workspace_id uuid NOT NULL, candidate_id uuid NOT NULL, candidate_revision integer NOT NULL CHECK(candidate_revision>0),
 revision integer NOT NULL CHECK(revision>0), owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 fit text NOT NULL CHECK(fit IN ('positive','unknown','negative')),
 value text NOT NULL CHECK(value IN ('positive','unknown')), timing text NOT NULL CHECK(timing IN ('positive','unknown')),
 source_url text NOT NULL CHECK(length(source_url) BETWEEN 1 AND 2000), source_key text NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),
 roles jsonb NOT NULL DEFAULT '[]' CHECK(valid_prospect_priority_roles(roles)),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,candidate_id), FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CHECK(expires_at>decided_at AND expires_at<=decided_at+interval '30 days')
);
CREATE TABLE sourcing_prospect_considerations (
 workspace_id uuid NOT NULL,candidate_id uuid NOT NULL,candidate_revision integer NOT NULL CHECK(candidate_revision>0),id uuid NOT NULL,
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 assessment_revision integer NOT NULL CHECK(assessment_revision>=0),disposition text NOT NULL CHECK(disposition IN ('considered','selected')),
 policy_version text NOT NULL CHECK(policy_version='prospect-priority-v1'),
 role_source_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(role_source_ids)<=8),
 role_kinds text[] NOT NULL DEFAULT '{}' CHECK(cardinality(role_kinds)<=4 AND role_kinds<@ARRAY['workflow_owner','budget_approver','advocate','implementation']),
 source_key text NOT NULL CHECK(source_key ~ '^[a-f0-9]{64}$'),source_url text,decided_at timestamptz,
 fit text NOT NULL CHECK(fit IN ('positive','unknown','negative')),value text NOT NULL CHECK(value IN ('positive','unknown')),timing text NOT NULL CHECK(timing IN ('positive','unknown')),
 roles jsonb NOT NULL DEFAULT '[]' CHECK(valid_prospect_priority_roles(roles)),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CHECK(expires_at>occurred_at AND expires_at<=occurred_at+interval '30 days')
);
CREATE INDEX sourcing_prospect_consideration_candidate ON sourcing_prospect_considerations(workspace_id,candidate_id,candidate_revision,occurred_at DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON sourcing_prospect_priorities,sourcing_prospect_considerations TO app_runtime,migration;
CREATE FUNCTION erase_prospect_priority_sources(w uuid,urls text[]) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint; m bigint;
BEGIN
 WITH removed AS (DELETE FROM sourcing_prospect_priorities a USING sourcing_candidates c WHERE a.workspace_id=w AND c.workspace_id=w AND a.candidate_id=c.id
 AND (rtrim(c.payload->>'sourceUrl','/')=ANY(urls) OR rtrim(c.source_check->'lastSuccess'->>'url','/')=ANY(urls)
 OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=w AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=ANY(urls))) RETURNING a.candidate_id) SELECT count(*) INTO n FROM removed;
 WITH removed AS (DELETE FROM sourcing_prospect_considerations a USING sourcing_candidates c WHERE a.workspace_id=w AND c.workspace_id=w AND a.candidate_id=c.id
 AND (rtrim(c.payload->>'sourceUrl','/')=ANY(urls) OR rtrim(c.source_check->'lastSuccess'->>'url','/')=ANY(urls)
 OR EXISTS(SELECT 1 FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=w AND o.candidate_id=c.id AND rtrim(o.source->>'sourceUrl','/')=ANY(urls))) RETURNING a.id) SELECT count(*) INTO m FROM removed;
 RETURN n+m;
END $$;
CREATE FUNCTION prospect_priority_candidate_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.revision,NEW.payload,NEW.status) IS DISTINCT FROM (OLD.revision,OLD.payload,OLD.status) THEN
  DELETE FROM sourcing_prospect_priorities WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.id;
  -- Preserve minimal as-selected history through benign candidate progression.
  UPDATE sourcing_prospect_considerations SET roles='[]'::jsonb WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.id;
 END IF;
 -- Same-source spelling/name correction preserves the minimal as-selected facts.
 -- Any other payload/identity association change remains conservatively erased.
 IF (NEW.payload #- '{firmName}' #- '{row,firmName}') IS DISTINCT FROM (OLD.payload #- '{firmName}' #- '{row,firmName}') OR NEW.status='dismissed' THEN
  DELETE FROM sourcing_prospect_considerations WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.id;
 END IF;
 IF NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text') THEN
  PERFORM erase_prospect_priority_sources(OLD.workspace_id,ARRAY[rtrim(OLD.payload->>'sourceUrl','/'),rtrim(OLD.source_check->'lastSuccess'->>'url','/'),rtrim(NEW.source_check->'lastSuccess'->>'url','/')]);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_candidate_lifecycle BEFORE UPDATE OF revision,payload,status,source_check ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION prospect_priority_candidate_lifecycle();
CREATE FUNCTION prospect_priority_origin_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sourcing_prospect_priorities WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id;
 DELETE FROM sourcing_prospect_considerations WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_origin_lifecycle BEFORE UPDATE OR DELETE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION prospect_priority_origin_lifecycle();
CREATE FUNCTION prospect_priority_owner_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.status<>'active' OR NEW.role<>'admin' THEN
  DELETE FROM sourcing_prospect_priorities WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
  DELETE FROM sourcing_prospect_considerations WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_owner_lifecycle BEFORE UPDATE OF role,status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION prospect_priority_owner_lifecycle();

CREATE FUNCTION prospect_priority_role_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; x uuid; key text;
BEGIN
 w:=OLD.workspace_id;x:=OLD.id;
 IF TG_TABLE_NAME='crm_people' THEN key:='personId';
 ELSIF TG_TABLE_NAME='crm_relationships' THEN key:='relationshipId';
 ELSIF TG_TABLE_NAME='crm_selected_sources' THEN
  DELETE FROM sourcing_prospect_priorities a WHERE a.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.roles) v JOIN crm_relationships r ON r.workspace_id=w AND r.id::text=(v->>'relationshipId') WHERE r.source_id=x);
  UPDATE sourcing_prospect_considerations a SET roles='[]'::jsonb,role_kinds='{}',role_source_ids='{}' WHERE a.workspace_id=w AND (x=ANY(a.role_source_ids) OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.roles) v JOIN crm_relationships r ON r.workspace_id=w AND r.id::text=(v->>'relationshipId') WHERE r.source_id=x));
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 ELSE
  DELETE FROM sourcing_prospect_priorities a WHERE a.workspace_id=w AND jsonb_array_length(a.roles)>0 AND EXISTS(SELECT 1 FROM sourcing_admissions d WHERE d.workspace_id=w AND d.candidate_id=a.candidate_id AND d.firm_id=x);
  UPDATE sourcing_prospect_considerations a SET roles='[]'::jsonb WHERE a.workspace_id=w AND jsonb_array_length(a.roles)>0 AND EXISTS(SELECT 1 FROM sourcing_admissions d WHERE d.workspace_id=w AND d.candidate_id=a.candidate_id AND d.firm_id=x);
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 DELETE FROM sourcing_prospect_priorities a WHERE a.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.roles) v WHERE v->>key=x::text);
 UPDATE sourcing_prospect_considerations a SET roles='[]'::jsonb,role_kinds=CASE WHEN TG_OP='DELETE' THEN '{}'::text[] ELSE role_kinds END WHERE a.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.roles) v WHERE v->>key=x::text);
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_person_lifecycle BEFORE UPDATE OR DELETE ON crm_people FOR EACH ROW EXECUTE FUNCTION prospect_priority_role_lifecycle();
CREATE TRIGGER prospect_priority_relationship_lifecycle BEFORE UPDATE OR DELETE ON crm_relationships FOR EACH ROW EXECUTE FUNCTION prospect_priority_role_lifecycle();
CREATE TRIGGER prospect_priority_selected_source_lifecycle BEFORE UPDATE OR DELETE ON crm_selected_sources FOR EACH ROW EXECUTE FUNCTION prospect_priority_role_lifecycle();
CREATE TRIGGER prospect_priority_firm_lifecycle BEFORE UPDATE OF status,assigned_user_id OR DELETE ON firms FOR EACH ROW EXECUTE FUNCTION prospect_priority_role_lifecycle();
CREATE FUNCTION prospect_priority_admission_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM sourcing_prospect_priorities WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id AND jsonb_array_length(roles)>0;
 UPDATE sourcing_prospect_considerations SET roles='[]'::jsonb WHERE workspace_id=OLD.workspace_id AND candidate_id=OLD.candidate_id AND jsonb_array_length(roles)>0;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_admission_lifecycle BEFORE UPDATE OR DELETE ON sourcing_admissions FOR EACH ROW EXECUTE FUNCTION prospect_priority_admission_lifecycle();

-- Selection-time metadata is immutable; only removal of optional role references
-- and role kinds is allowed during normal identity/source erasure.
CREATE FUNCTION prospect_priority_selection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'roles'-'role_kinds'-'role_source_ids') IS DISTINCT FROM (to_jsonb(OLD)-'roles'-'role_kinds'-'role_source_ids')
  OR (NEW.roles IS DISTINCT FROM OLD.roles AND NEW.roles<>'[]'::jsonb)
  OR (NEW.role_kinds IS DISTINCT FROM OLD.role_kinds AND cardinality(NEW.role_kinds)<>0)
  OR (NEW.role_source_ids IS DISTINCT FROM OLD.role_source_ids AND cardinality(NEW.role_source_ids)<>0) THEN
  RAISE EXCEPTION 'selection context is immutable except role erasure' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_priority_selection_immutable BEFORE UPDATE ON sourcing_prospect_considerations FOR EACH ROW EXECUTE FUNCTION prospect_priority_selection_immutable();
