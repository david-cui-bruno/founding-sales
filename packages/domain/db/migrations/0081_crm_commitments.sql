-- #490 final81 follows #48480. No copied quotation bodies.
-- changes: jobs
CREATE FUNCTION crm_commitment_projection_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE key text;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(value))<>14 OR NOT(value ?& ARRAY['activationKey','taskId','reviewRevision','sourceKind','sourceId','sourceRevision','sourceHash','anchorId','decisionRevision','contextHash','outcome','observedAt','jobId','fencingToken']) THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['reviewRevision','sourceRevision','decisionRevision'] LOOP
  IF jsonb_typeof(value->key)<>'number' OR (value->>key)!~'^[0-9]+$' THEN RETURN false; END IF;
 END LOOP;
 IF (value->>'reviewRevision')::numeric<1 OR (value->>'sourceRevision')::numeric<1 THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['sourceId','anchorId','jobId'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR (value->>key)!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['sourceHash','contextHash','activationKey'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR (value->>key)!~'^[a-f0-9]{64}$' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_typeof(value->'sourceKind')<>'string' OR jsonb_typeof(value->'outcome')<>'string' OR value->>'sourceKind' NOT IN ('selected_note','mail','call_transcript','meeting_transcript') OR value->>'outcome' NOT IN ('applied','suggestion','review_required','already_completed')
 OR jsonb_typeof(value->'fencingToken')<>'string' OR (value->>'fencingToken')!~'^[1-9][0-9]{0,18}$'
 OR jsonb_typeof(value->'observedAt')<>'string' OR (value->>'observedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 IF value->'taskId'<>'null'::jsonb AND (jsonb_typeof(value->'taskId')<>'string' OR (value->>'taskId')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
 PERFORM (value->>'observedAt')::timestamptz;
 RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE crm_commitment_reviews (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 family_key text NOT NULL CHECK(family_key ~ '^[a-f0-9]{64}$'),activation_key text CHECK(activation_key ~ '^[a-f0-9]{64}$'),anchor_id uuid,
 target jsonb,initial_context_snapshot jsonb,context_snapshot jsonb,original_access_closure jsonb,
 basis text CONSTRAINT crm_commitment_basis CHECK(basis IN ('human','verified_original')),classification text CHECK(classification IN ('internal_promise','commercial','ambiguous')),
 actor text CHECK(actor IN ('self','counterparty','unknown')),action_label text CHECK(length(btrim(action_label)) BETWEEN 1 AND 300),
 due jsonb,source_zone_receipt jsonb,today_eligibility text CONSTRAINT crm_commitment_today_eligibility CHECK(today_eligibility IN ('current','historical','unknown')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),projected_revision integer NOT NULL DEFAULT 0 CHECK(projected_revision>=0 AND projected_revision<=revision),
 projection_version integer NOT NULL DEFAULT 0 CHECK(projection_version>=0),projection_receipt jsonb CONSTRAINT crm_commitment_projection_shape CHECK(projection_receipt IS NULL OR (crm_commitment_projection_valid(projection_receipt) AND (projection_receipt->>'reviewRevision')::numeric=projected_revision)),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','suggestion','review_required','redacted')),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,anchor_id) REFERENCES crm_claim_review_anchors(workspace_id,id) ON DELETE SET NULL(anchor_id),
 CONSTRAINT crm_commitment_review_private_shape CHECK(
  (state='redacted' AND anchor_id IS NULL AND target IS NULL AND initial_context_snapshot IS NULL AND activation_key IS NULL AND context_snapshot IS NULL AND original_access_closure IS NULL AND basis IS NULL AND classification IS NULL AND actor IS NULL AND action_label IS NULL AND due IS NULL AND source_zone_receipt IS NULL AND projection_receipt IS NULL AND today_eligibility IS NULL)
  OR (state<>'redacted' AND anchor_id IS NOT NULL AND target IS NOT NULL AND activation_key IS NOT NULL AND crm_extraction_context_valid(initial_context_snapshot) AND crm_extraction_context_valid(context_snapshot) AND crm_access_closure_valid(original_access_closure) AND basis IS NOT NULL AND classification IS NOT NULL AND actor IS NOT NULL AND action_label IS NOT NULL AND today_eligibility IS NOT NULL))
);
CREATE UNIQUE INDEX crm_commitment_current_family ON crm_commitment_reviews(workspace_id,family_key) WHERE state<>'redacted';
CREATE FUNCTION crm_commitment_activation_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE key text;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>16 OR NOT(value ?& ARRAY['reviewId','reviewRevision','activationKey','sourceKind','sourceId','sourceRevision','sourceHash','anchorId','decisionRevision','contextHash','initialContextSnapshot','contextSnapshot','originalAccessClosure','actionHash','dueHash','activatedAt']) THEN RETURN false; END IF;
 FOREACH key IN ARRAY ARRAY['reviewId','sourceId','anchorId'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR (value->>key)!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['activationKey','sourceHash','contextHash','actionHash','dueHash'] LOOP
  IF jsonb_typeof(value->key)<>'string' OR (value->>key)!~'^[a-f0-9]{64}$' THEN RETURN false; END IF;
 END LOOP;
 FOREACH key IN ARRAY ARRAY['reviewRevision','sourceRevision','decisionRevision'] LOOP
  IF jsonb_typeof(value->key)<>'number' OR (value->>key)!~'^[0-9]+$' THEN RETURN false; END IF;
 END LOOP;
 IF (value->>'reviewRevision')::numeric<1 OR (value->>'sourceRevision')::numeric<1 OR jsonb_typeof(value->'sourceKind') IS DISTINCT FROM 'string' OR value->>'sourceKind' NOT IN ('selected_note','mail','call_transcript','meeting_transcript') OR NOT crm_extraction_context_valid(value->'initialContextSnapshot') OR NOT crm_extraction_context_valid(value->'contextSnapshot') OR NOT crm_access_closure_valid(value->'originalAccessClosure') OR jsonb_typeof(value->'activatedAt')<>'string' OR (value->>'activatedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 PERFORM (value->>'activatedAt')::timestamptz;
 RETURN true;
 EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE crm_internal_tasks (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 task_key text NOT NULL CHECK(task_key ~ '^[a-f0-9]{64}$'),review_id uuid,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 activation_receipt jsonb,completed_at timestamptz,review_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,task_key),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,review_id) REFERENCES crm_commitment_reviews(workspace_id,id) ON DELETE SET NULL(review_id),
 CONSTRAINT crm_internal_activation_shape CHECK((activation_receipt IS NULL AND review_id IS NULL) OR (activation_receipt IS NOT NULL AND crm_commitment_activation_valid(activation_receipt) AND activation_receipt->>'activationKey'=task_key AND review_id IS NOT NULL)),
 CONSTRAINT crm_internal_completion_shape CHECK((status='done')=(completed_at IS NOT NULL))
);
GRANT SELECT,INSERT,UPDATE ON crm_commitment_reviews,crm_internal_tasks TO app_runtime,migration;
CREATE FUNCTION crm_commitment_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.family_key) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.family_key)
 OR (NEW.state<>'redacted' AND ROW(NEW.initial_context_snapshot,NEW.original_access_closure) IS DISTINCT FROM ROW(OLD.initial_context_snapshot,OLD.original_access_closure))
 OR OLD.basis='human' AND NEW.basis='verified_original'
 OR OLD.state='redacted' AND NEW.state<>'redacted'
 OR NEW.revision<OLD.revision OR NEW.revision>OLD.revision+1
 OR (NEW.state<>'redacted' AND NEW.revision=OLD.revision AND ROW(NEW.basis,NEW.activation_key,NEW.anchor_id,NEW.target,NEW.context_snapshot,NEW.original_access_closure,NEW.classification,NEW.actor,NEW.action_label,NEW.due,NEW.source_zone_receipt,NEW.today_eligibility,NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.basis,OLD.activation_key,OLD.anchor_id,OLD.target,OLD.context_snapshot,OLD.original_access_closure,OLD.classification,OLD.actor,OLD.action_label,OLD.due,OLD.source_zone_receipt,OLD.today_eligibility,OLD.reviewed_at))
 OR NEW.projection_version<OLD.projection_version OR NEW.projection_version>OLD.projection_version+1
 OR (NEW.revision=OLD.revision AND ROW(NEW.state,NEW.projected_revision,NEW.projection_receipt) IS DISTINCT FROM ROW(OLD.state,OLD.projected_revision,OLD.projection_receipt) AND NEW.projection_version<>OLD.projection_version+1)
 OR (NEW.projection_receipt IS DISTINCT FROM OLD.projection_receipt AND NEW.projection_receipt IS NOT NULL AND (NEW.revision<>OLD.revision OR NEW.projected_revision<>NEW.revision))
 OR NEW.projected_revision<OLD.projected_revision
 THEN RAISE EXCEPTION 'Human commitment reviews are versioned independently from projection' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_commitment_review_guard BEFORE UPDATE ON crm_commitment_reviews FOR EACH ROW EXECUTE FUNCTION crm_commitment_review_guard();
CREATE FUNCTION crm_internal_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (ROW(NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.task_key) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.task_key)
 OR (ROW(NEW.status,NEW.completed_at,NEW.review_id,NEW.activation_receipt,NEW.review_required) IS DISTINCT FROM ROW(OLD.status,OLD.completed_at,OLD.review_id,OLD.activation_receipt,OLD.review_required) AND NEW.version<>OLD.version+1)
 OR OLD.status='done' AND ROW(NEW.status,NEW.completed_at) IS DISTINCT FROM ROW(OLD.status,OLD.completed_at)
 OR OLD.status='cancelled' AND NEW.status<>'cancelled'
 OR NEW.version<OLD.version OR NEW.version>OLD.version+1
 OR (OLD.activation_receipt IS NOT NULL AND NEW.activation_receipt IS NOT NULL AND NEW.activation_receipt IS DISTINCT FROM OLD.activation_receipt)
 OR (OLD.status='done' AND (OLD.review_id IS NULL AND NEW.review_id IS NOT NULL OR OLD.activation_receipt IS NULL AND NEW.activation_receipt IS NOT NULL))
 ) THEN RAISE EXCEPTION 'Completed internal actions and task identity are immutable' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 IF NEW.review_id IS NOT NULL AND EXISTS(SELECT 1 FROM crm_commitment_reviews r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.review_id) AND NOT EXISTS(SELECT 1 FROM crm_commitment_reviews r JOIN crm_commitment_reviews initial ON initial.workspace_id=r.workspace_id AND initial.id=(NEW.activation_receipt->>'reviewId')::uuid WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.review_id AND r.owner_user_id=NEW.owner_user_id AND initial.owner_user_id=NEW.owner_user_id AND initial.family_key=r.family_key AND r.activation_key=NEW.task_key) THEN RAISE EXCEPTION 'Task activation owner and review must match' USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_internal_task_guard BEFORE INSERT OR UPDATE ON crm_internal_tasks FOR EACH ROW EXECUTE FUNCTION crm_internal_task_guard();
CREATE FUNCTION crm_commitment_anchor_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.availability='deleted' THEN
  UPDATE crm_internal_tasks SET review_id=NULL,activation_receipt=NULL,review_required=true,version=version+1 WHERE workspace_id=NEW.workspace_id AND activation_receipt IS NOT NULL AND ((activation_receipt->>'anchorId')::uuid=NEW.id OR review_id IN(SELECT id FROM crm_commitment_reviews WHERE workspace_id=NEW.workspace_id AND anchor_id=NEW.id));
  UPDATE crm_commitment_reviews SET anchor_id=NULL,target=NULL,activation_key=NULL,initial_context_snapshot=NULL,context_snapshot=NULL,original_access_closure=NULL,basis=NULL,classification=NULL,actor=NULL,action_label=NULL,due=NULL,source_zone_receipt=NULL,today_eligibility=NULL,projection_receipt=NULL,projection_version=projection_version+1,state='redacted' WHERE workspace_id=NEW.workspace_id AND anchor_id=NEW.id;
 ELSIF NEW.current_decision_revision<>OLD.current_decision_revision THEN
  UPDATE crm_commitment_reviews SET state='review_required',projection_version=projection_version+1 WHERE workspace_id=NEW.workspace_id AND anchor_id=NEW.id AND state<>'redacted';
 END IF;
 UPDATE crm_internal_tasks t SET review_required=true,version=version+1 WHERE t.workspace_id=NEW.workspace_id AND t.status='open' AND EXISTS(SELECT 1 FROM crm_commitment_reviews r WHERE r.workspace_id=t.workspace_id AND r.id=t.review_id AND r.state IN ('review_required','redacted'));
 RETURN NEW;
END $$;
CREATE TRIGGER crm_commitment_anchor_change AFTER UPDATE ON crm_claim_review_anchors FOR EACH ROW EXECUTE FUNCTION crm_commitment_anchor_change();
