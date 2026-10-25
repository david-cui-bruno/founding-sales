-- Private current composition only. No publishing, account or generation foreign keys.
CREATE TABLE social_private_drafts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CONSTRAINT social_private_revision CHECK(revision>0),
 kind text NOT NULL CONSTRAINT social_private_kind CHECK(kind IN ('post','comment')),
 origin_kind text NOT NULL CONSTRAINT social_private_origin_kind CHECK(origin_kind IN ('manual','suggestion')),
 text text,
 origin jsonb,
 source_selection jsonb,
 source_hash text,
 dependencies jsonb NOT NULL DEFAULT '{}',
 reason text CONSTRAINT social_private_reason CHECK(reason IN ('expired','source_changed_or_unavailable','removed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '90 days',
 PRIMARY KEY(workspace_id,id),
 CONSTRAINT social_private_owner_fk FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CONSTRAINT social_private_text CHECK(text IS NULL OR (length(text) BETWEEN 1 AND 10000 AND length(btrim(text))>0 AND octet_length(text)<=40000)),
 CONSTRAINT social_private_origin CHECK(origin IS NULL OR (jsonb_typeof(origin)='object' AND octet_length(origin::text)<=1024 AND origin->>'kind'=origin_kind)),
 CONSTRAINT social_private_source CHECK(source_selection IS NULL OR (jsonb_typeof(source_selection)='object' AND octet_length(source_selection::text)<=8192)),
 CONSTRAINT social_private_hash CHECK(source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT social_private_dependencies CHECK(jsonb_typeof(dependencies)='object' AND octet_length(dependencies::text)<=16384),
 CONSTRAINT social_private_lifetime CHECK(expires_at>created_at AND expires_at<=created_at+interval '90 days'),
 CONSTRAINT social_private_live_shape CHECK(
  (reason IS NOT NULL AND text IS NULL AND origin IS NULL AND source_selection IS NULL AND source_hash IS NULL AND dependencies='{}'::jsonb)
  OR (reason IS NULL AND text IS NOT NULL AND origin IS NOT NULL AND
   ((origin_kind='manual' AND source_selection IS NULL AND source_hash IS NULL AND dependencies='{}'::jsonb)
    OR (origin_kind='suggestion' AND source_selection IS NOT NULL AND source_hash IS NOT NULL))))
);
CREATE INDEX social_private_owner ON social_private_drafts(workspace_id,owner_user_id,id);
CREATE INDEX social_private_expiry ON social_private_drafts(workspace_id,expires_at) WHERE reason IS NULL;
CREATE INDEX social_private_dependencies_index ON social_private_drafts USING gin(dependencies);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_private_drafts TO app_runtime,migration;

-- Source writers already hold their ordinary source/association row locks. Save
-- takes those same locks before the private row, so erasure cannot race resurrection.
-- This integrates every normal source DELETE/retention path, not just one API.
CREATE FUNCTION erase_social_private_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row jsonb; source_id text; source_key text;
BEGIN
 source_row := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 source_key := TG_TABLE_NAME;
 source_id := source_row->>'id';
 IF TG_TABLE_NAME='call_transcripts' THEN source_key:='call_sessions'; source_id:=source_row->>'call_session_id'; END IF;
 IF TG_TABLE_NAME='outreach_answer_block_versions' THEN source_key:='outreach_answer_blocks'; source_id:=source_row->>'block_id'; END IF;
 IF TG_TABLE_NAME='meeting_transcripts' THEN
  UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp()
  WHERE workspace_id=(source_row->>'workspace_id')::uuid AND reason IS NULL
   AND (dependencies @> jsonb_build_object('meeting_transcripts',jsonb_build_array(source_id))
    OR dependencies @> jsonb_build_object('meeting_recordings',jsonb_build_array(source_row->>'recording_id')));
 ELSE
  UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp()
  WHERE workspace_id=(source_row->>'workspace_id')::uuid AND reason IS NULL
   AND dependencies @> jsonb_build_object(source_key,jsonb_build_array(source_id));
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_private_call_transcripts AFTER UPDATE OR DELETE ON call_transcripts FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_call_sessions AFTER UPDATE OF actor_user_id,firm_id OR DELETE ON call_sessions FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_meeting_transcripts AFTER INSERT OR UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_meeting_recordings AFTER UPDATE OR DELETE ON meeting_recordings FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_meetings AFTER UPDATE OF firm_id OR DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_firms AFTER UPDATE OF status,assigned_user_id OR DELETE ON firms FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_candidates AFTER UPDATE OR DELETE ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_facts AFTER UPDATE OR DELETE ON outreach_answer_blocks FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE TRIGGER social_private_fact_versions AFTER UPDATE OR DELETE ON outreach_answer_block_versions FOR EACH ROW EXECUTE FUNCTION erase_social_private_source();
CREATE FUNCTION erase_departed_social_private_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.status<>'active' THEN
  UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='removed',revision=revision+1,updated_at=clock_timestamp()
  WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id AND reason IS NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_private_owner_departure AFTER UPDATE OF status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION erase_departed_social_private_owner();
