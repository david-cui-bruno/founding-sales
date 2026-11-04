-- changes: social_assets, social_asset_objects, workspace_memberships
-- New uploads alone enter quarantine; historical objects are not reclassified.
ALTER TABLE social_assets ADD COLUMN media_quarantined boolean NOT NULL DEFAULT false;
ALTER TABLE social_assets ADD COLUMN approval_revision integer NOT NULL DEFAULT 0 CHECK(approval_revision>=0);
ALTER TABLE social_assets ADD COLUMN approved_version integer;
ALTER TABLE social_assets ADD COLUMN approved_sha256 text;
ALTER TABLE social_assets ADD COLUMN approved_caption text CHECK(length(approved_caption)<=1000);
ALTER TABLE social_assets ADD COLUMN approved_topic text CHECK(length(approved_topic)<=200);
ALTER TABLE social_assets ADD COLUMN approved_alt_text text CHECK(length(approved_alt_text)<=1000);
ALTER TABLE social_assets ADD COLUMN approved_at timestamptz;
ALTER TABLE social_asset_objects ADD COLUMN sanitized boolean NOT NULL DEFAULT false;
-- Membership loss is an immediate terminal fence, even before the cleanup worker runs.
ALTER TABLE social_asset_objects ADD CONSTRAINT social_asset_sanitized_derivative CHECK(NOT sanitized OR kind='derivative');
ALTER TABLE social_assets ADD CONSTRAINT social_asset_approval_complete CHECK(
 (approved_version IS NULL AND approved_sha256 IS NULL AND approved_caption IS NULL AND approved_topic IS NULL AND approved_alt_text IS NULL AND approved_at IS NULL)
 OR
 (approved_version>1 AND approved_sha256 ~ '^[a-f0-9]{64}$' AND btrim(approved_caption)<>'' AND btrim(approved_topic)<>'' AND btrim(approved_alt_text)<>'' AND approved_at IS NOT NULL
  AND approved_version IS NOT NULL AND approved_sha256 IS NOT NULL AND approved_caption IS NOT NULL AND approved_topic IS NOT NULL AND approved_alt_text IS NOT NULL)
);
CREATE FUNCTION social_media_owner_departure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.status<>'active' THEN
  INSERT INTO social_object_deletions(workspace_id,asset_id,version,object_key,bytes,next_attempt_at)
   SELECT o.workspace_id,o.asset_id,o.version,o.object_key,o.bytes,clock_timestamp()+interval '10 minutes'
   FROM social_asset_objects o JOIN social_assets a ON a.workspace_id=o.workspace_id AND a.id=o.asset_id
   WHERE a.workspace_id=OLD.workspace_id AND a.owner_user_id=OLD.user_id ON CONFLICT DO NOTHING;
  UPDATE social_asset_objects o SET state='deleted' FROM social_assets a WHERE a.workspace_id=o.workspace_id AND a.id=o.asset_id AND a.workspace_id=OLD.workspace_id AND a.owner_user_id=OLD.user_id;
  UPDATE social_assets SET state='deleted',deleted_at=COALESCE(deleted_at,clock_timestamp()),origin='{"kind":"upload","sourceUrl":null,"usageNote":null}'::jsonb,approval_revision=approval_revision+1,approved_version=NULL,approved_sha256=NULL,approved_caption=NULL,approved_topic=NULL,approved_alt_text=NULL,approved_at=NULL WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER social_media_owner_departure AFTER UPDATE OF status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION social_media_owner_departure();
