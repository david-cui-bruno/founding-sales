-- changes: social_draft_requests, social_private_drafts, social_voice_preferences, workspace_memberships
-- Exact guide-dependent current outputs only. Existing0135/0136 retain owner
-- composition/guide erasure. Reservations and opaque request history stay intact.
CREATE FUNCTION erase_social_voice_generation_outputs(
 p_workspace uuid, p_owner uuid, p_guide uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE social_draft_requests
 SET state=CASE WHEN state IN ('queued','calling','ready') THEN 'review' ELSE state END,
     concepts=NULL,reason='source_changed_or_unavailable',updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND owner_user_id=p_owner
   AND source_selection->'voiceGuideRef'->>'guideId'=p_guide::text;
 UPDATE social_private_drafts
 SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,
     dependencies='{}',reason='source_changed_or_unavailable',
     revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=p_workspace AND owner_user_id=p_owner AND reason IS NULL
   AND source_selection->'voiceGuideRef'->>'guideId'=p_guide::text;
END $$;

CREATE FUNCTION erase_changed_social_voice_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM erase_social_voice_generation_outputs(OLD.workspace_id,OLD.owner_user_id,OLD.id);
 ELSIF NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.entries IS DISTINCT FROM OLD.entries
    OR NEW.removed_at IS DISTINCT FROM OLD.removed_at
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.id IS DISTINCT FROM OLD.id THEN
  PERFORM erase_social_voice_generation_outputs(OLD.workspace_id,OLD.owner_user_id,OLD.id);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_voice_generation_changed
AFTER UPDATE OF revision,entries,removed_at,workspace_id,owner_user_id,id OR DELETE
ON social_voice_preferences FOR EACH ROW
EXECUTE FUNCTION erase_changed_social_voice_generation();

-- Membership lifecycle already holds its parent row. Lock guide before dependent
-- request/private rows, matching reads/adoption. Existing0136 clears guide content
-- on departure; the guide DELETE trigger covers cascade ordering independently.
CREATE FUNCTION erase_departed_social_voice_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE guide record;
BEGIN
 IF TG_OP='DELETE' THEN
  FOR guide IN SELECT id FROM social_voice_preferences
   WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id
   ORDER BY id FOR UPDATE LOOP
   PERFORM erase_social_voice_generation_outputs(OLD.workspace_id,OLD.user_id,guide.id);
  END LOOP;
 ELSIF NEW.status IS DISTINCT FROM 'active' OR NEW.role IS DISTINCT FROM OLD.role THEN
  FOR guide IN SELECT id FROM social_voice_preferences
   WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id
   ORDER BY id FOR UPDATE LOOP
   PERFORM erase_social_voice_generation_outputs(OLD.workspace_id,OLD.user_id,guide.id);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_voice_generation_owner_departure
AFTER UPDATE OF status,role OR DELETE ON workspace_memberships
FOR EACH ROW EXECUTE FUNCTION erase_departed_social_voice_generation();
