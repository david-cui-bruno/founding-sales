-- changes: social_standing_plans,social_standing_slots,social_standing_lineage,social_post_approvals,social_post_revisions,social_founder_inputs,social_voice_preferences,social_assets,workspace_memberships
-- Delegation is distinct from historical recurring approval. Slot and lineage custody
-- survive policy revisions and never retain private input prose.
CREATE TABLE social_standing_plans (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CONSTRAINT social_standing_plan_revision CHECK(revision>0),state text NOT NULL CONSTRAINT social_standing_plan_state CHECK(state IN ('active','paused')),
 configuration jsonb NOT NULL,budget_timezone text NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT social_standing_plan_key PRIMARY KEY(workspace_id,id),CONSTRAINT social_standing_plan_owner UNIQUE(workspace_id,owner_user_id)
);
CREATE TABLE social_standing_slots (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 plan_id uuid NOT NULL,plan_revision integer NOT NULL,revision integer NOT NULL DEFAULT 1,
 local_week date NOT NULL,ordinal smallint NOT NULL CONSTRAINT social_standing_slot_ordinal CHECK(ordinal BETWEEN 1 AND 3),publish_at timestamptz,local_target text,
 state text NOT NULL DEFAULT 'preparing' CONSTRAINT social_standing_slot_state CHECK(state IN ('preparing','queued','skipped','held','submitting','scheduled','published','cancellation_pending','cancelled','failed_known_not_submitted','unknown')),
 reason text,input_refs jsonb NOT NULL DEFAULT '[]',image jsonb,text text,
 generation_request_id uuid,post_id uuid,attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
 fingerprint text,submission_marked_at timestamptz,receipt_id text,permalink text,
 snapshot jsonb,inspection_deadline timestamptz,next_inspection_at timestamptz,
 CONSTRAINT social_standing_slot_key PRIMARY KEY(workspace_id,id),CONSTRAINT social_standing_slot_week UNIQUE(workspace_id,owner_user_id,local_week,ordinal),
 CONSTRAINT social_standing_slot_request UNIQUE(workspace_id,generation_request_id),CONSTRAINT social_standing_slot_attempt UNIQUE(workspace_id,attempt_id),
 CONSTRAINT social_standing_slot_target_instant UNIQUE(workspace_id,owner_user_id,publish_at),
 CONSTRAINT social_standing_slot_plan FOREIGN KEY(workspace_id,plan_id) REFERENCES social_standing_plans(workspace_id,id)
);
CREATE TABLE social_standing_lineage (
 workspace_id uuid NOT NULL,owner_user_id uuid NOT NULL,input_id uuid NOT NULL,slot_id uuid NOT NULL,
 CONSTRAINT social_standing_lineage_key PRIMARY KEY(workspace_id,owner_user_id,input_id),
 CONSTRAINT social_standing_lineage_slot FOREIGN KEY(workspace_id,slot_id) REFERENCES social_standing_slots(workspace_id,id)
);
CREATE INDEX social_standing_due ON social_standing_slots(workspace_id,state,publish_at);
GRANT SELECT,INSERT,UPDATE ON social_standing_plans,social_standing_slots TO app_runtime,migration;
GRANT SELECT,INSERT ON social_standing_lineage TO app_runtime,migration;
ALTER TABLE social_post_approvals ADD COLUMN delegated_slot_id uuid;
ALTER TABLE social_post_approvals ADD CONSTRAINT social_approval_delegated_slot FOREIGN KEY(workspace_id,delegated_slot_id) REFERENCES social_standing_slots(workspace_id,id);
ALTER TABLE social_post_approvals DROP CONSTRAINT social_approval_origin;
ALTER TABLE social_post_approvals ADD CONSTRAINT social_approval_origin CHECK(
 (approval_kind='manual' AND approved_by IS NOT NULL AND standing_slot_id IS NULL AND delegated_slot_id IS NULL)
 OR (approval_kind='standing_policy' AND approved_by IS NULL AND standing_slot_id IS NOT NULL AND delegated_slot_id IS NULL)
 OR (approval_kind='founder_standing_v1' AND approved_by IS NULL AND standing_slot_id IS NULL AND delegated_slot_id IS NOT NULL));
ALTER TABLE social_post_revisions DROP CONSTRAINT social_post_revisions_text_check;
ALTER TABLE social_post_revisions ADD CONSTRAINT social_post_revisions_text_check CHECK(length(text) BETWEEN 1 AND 10000 OR (text='' AND state IN ('cancelled','submitting','scheduled','published','unknown','cancellation_pending')));

-- Current-only derived prose. Submitted evidence is retained for bounded inspect,
-- never turned back into eligible work by erasure.
CREATE FUNCTION erase_social_standing_outputs(w uuid,u uuid,input_id uuid DEFAULT NULL,asset_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE social_post_approvals a SET snapshot='{}'::jsonb
 FROM social_standing_slots s WHERE s.workspace_id=w AND s.owner_user_id=u
 AND (input_id IS NULL OR s.input_refs @> jsonb_build_array(jsonb_build_object('inputId',input_id)))
 AND (asset_id IS NULL OR s.image->>'assetId'=asset_id::text)
 AND a.workspace_id=s.workspace_id AND a.delegated_slot_id=s.id;
 UPDATE social_post_revisions r SET text='',images='[]',state=CASE WHEN s.submission_marked_at IS NULL THEN 'cancelled' ELSE r.state END,reason='source_changed_or_unavailable'
 FROM social_standing_slots s WHERE s.workspace_id=w AND s.owner_user_id=u
 AND (input_id IS NULL OR s.input_refs @> jsonb_build_array(jsonb_build_object('inputId',input_id)))
 AND (asset_id IS NULL OR s.image->>'assetId'=asset_id::text)
 AND r.workspace_id=s.workspace_id AND r.post_id=s.post_id;
 UPDATE social_standing_slots s SET text=NULL,image=NULL,snapshot=NULL,state='cancelled',reason='source_changed_or_unavailable',revision=revision+1
 WHERE s.workspace_id=w AND s.owner_user_id=u AND s.submission_marked_at IS NULL
 AND (input_id IS NULL OR s.input_refs @> jsonb_build_array(jsonb_build_object('inputId',input_id)))
 AND (asset_id IS NULL OR s.image->>'assetId'=asset_id::text);
 UPDATE social_standing_slots s SET text=NULL,image=NULL,
 snapshot=jsonb_set(CASE WHEN s.snapshot->'image' IS NOT NULL AND s.snapshot->'image'<>'null'::jsonb THEN jsonb_set(s.snapshot,'{image,altText}','""'::jsonb) ELSE s.snapshot END,'{text}','null'::jsonb)
 WHERE s.workspace_id=w AND s.owner_user_id=u AND s.submission_marked_at IS NOT NULL
 AND (input_id IS NULL OR s.input_refs @> jsonb_build_array(jsonb_build_object('inputId',input_id)))
 AND (asset_id IS NULL OR s.snapshot->'image'->>'assetId'=asset_id::text);
END $$;
REVOKE ALL ON FUNCTION erase_social_standing_outputs(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_social_standing_outputs(uuid,uuid,uuid,uuid) TO app_runtime,migration;
CREATE FUNCTION social_standing_source_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='social_founder_inputs' THEN
  PERFORM erase_social_standing_outputs(OLD.workspace_id,OLD.owner_user_id,OLD.id,NULL);
 ELSIF TG_TABLE_NAME='social_assets' THEN
  PERFORM erase_social_standing_outputs(OLD.workspace_id,OLD.owner_user_id,NULL,OLD.id);
 ELSIF TG_TABLE_NAME='social_voice_preferences' THEN
  PERFORM erase_social_standing_outputs(OLD.workspace_id,OLD.owner_user_id,NULL,NULL);
 ELSE
  IF TG_OP='DELETE' OR NEW.status<>'active' OR NEW.role<>'admin' THEN
   PERFORM erase_social_standing_outputs(OLD.workspace_id,OLD.user_id,NULL,NULL);
   UPDATE social_standing_plans SET state='paused',revision=revision+1 WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
  END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION social_standing_source_changed() FROM PUBLIC;
CREATE TRIGGER social_standing_input_erasure AFTER UPDATE OR DELETE ON social_founder_inputs FOR EACH ROW EXECUTE FUNCTION social_standing_source_changed();
CREATE TRIGGER social_standing_guide_erasure AFTER UPDATE OR DELETE ON social_voice_preferences FOR EACH ROW EXECUTE FUNCTION social_standing_source_changed();
CREATE TRIGGER social_standing_media_erasure AFTER UPDATE OF approved_version,approved_sha256,approval_revision,state OR DELETE ON social_assets FOR EACH ROW EXECUTE FUNCTION social_standing_source_changed();
CREATE TRIGGER social_standing_owner_erasure AFTER UPDATE OF status,role OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION social_standing_source_changed();
CREATE FUNCTION social_standing_candidate_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.submission_marked_at IS NULL AND (NEW.revision<>OLD.revision OR NEW.state IN ('cancelled','skipped','held','failed_known_not_submitted')) THEN
  UPDATE social_post_approvals SET snapshot='{}'::jsonb WHERE workspace_id=OLD.workspace_id AND delegated_slot_id=OLD.id;
  UPDATE social_post_revisions SET text='',images='[]',state='cancelled',reason='candidate_invalidated' WHERE workspace_id=OLD.workspace_id AND post_id=OLD.post_id;
  IF NEW.state IN ('cancelled','skipped','failed_known_not_submitted') THEN
   UPDATE social_draft_requests SET concepts=NULL,state=CASE WHEN state IN ('queued','calling','ready') THEN 'review' ELSE state END,reason='standing_slot_closed' WHERE workspace_id=OLD.workspace_id AND id=OLD.generation_request_id;
  END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION social_standing_candidate_changed() FROM PUBLIC;
CREATE TRIGGER social_standing_candidate_erasure AFTER UPDATE OF state,text,revision ON social_standing_slots FOR EACH ROW EXECUTE FUNCTION social_standing_candidate_changed();
CREATE FUNCTION fence_social_standing_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.plan_id,NEW.plan_revision,NEW.local_week,NEW.ordinal,NEW.publish_at,NEW.attempt_id)
 IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.plan_id,OLD.plan_revision,OLD.local_week,OLD.ordinal,OLD.publish_at,OLD.attempt_id)
 OR (OLD.generation_request_id IS NOT NULL AND NEW.generation_request_id IS DISTINCT FROM OLD.generation_request_id)
 OR (OLD.input_refs<>'[]'::jsonb AND NEW.input_refs IS DISTINCT FROM OLD.input_refs)
 THEN RAISE EXCEPTION 'social_standing_identity_immutable'; END IF;
 IF OLD.submission_marked_at IS NOT NULL THEN
  IF NEW.submission_marked_at IS DISTINCT FROM OLD.submission_marked_at OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
   OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.revision<>OLD.revision
   OR NEW.state IN ('preparing','queued','held','skipped','failed_known_not_submitted')
   OR (OLD.state IN ('published','cancelled') AND NEW.state<>OLD.state)
   OR (NEW.text IS DISTINCT FROM OLD.text AND NEW.text IS NOT NULL)
   OR (NEW.image IS DISTINCT FROM OLD.image AND NEW.image IS NOT NULL)
   OR NEW.snapshot IS NULL
   OR (NEW.snapshot-'text'-'image') IS DISTINCT FROM (OLD.snapshot-'text'-'image')
   OR (CASE WHEN jsonb_typeof(NEW.snapshot->'image')='object' THEN (NEW.snapshot->'image')-'altText' ELSE NEW.snapshot->'image' END)
      IS DISTINCT FROM (CASE WHEN jsonb_typeof(OLD.snapshot->'image')='object' THEN (OLD.snapshot->'image')-'altText' ELSE OLD.snapshot->'image' END)
   OR (NEW.snapshot->'text' IS DISTINCT FROM OLD.snapshot->'text' AND NEW.snapshot->'text'<>'null'::jsonb)
   OR (NEW.snapshot->'image'->'altText' IS DISTINCT FROM OLD.snapshot->'image'->'altText' AND NEW.snapshot->'image'->>'altText'<>'')
  THEN RAISE EXCEPTION 'social_standing_submission_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER social_standing_slot_fence BEFORE UPDATE ON social_standing_slots FOR EACH ROW EXECUTE FUNCTION fence_social_standing_slot();
ALTER TABLE social_standing_slots ADD CONSTRAINT social_standing_marked_attempt CHECK(submission_marked_at IS NULL OR (snapshot IS NOT NULL AND fingerprint IS NOT NULL AND fingerprint ~ '^[a-f0-9]{64}$' AND post_id IS NOT NULL AND state IN ('submitting','scheduled','published','cancellation_pending','cancelled','unknown')));
ALTER TABLE social_standing_slots ADD CONSTRAINT social_standing_target CHECK(publish_at IS NOT NULL OR (state IN ('skipped','cancelled') AND local_target IS NOT NULL));
