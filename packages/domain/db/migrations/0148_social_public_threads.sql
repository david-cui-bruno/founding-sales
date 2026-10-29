-- changes: social_public_threads
-- Retained public-web originals only. No acquisition, account, model or posting owner.
CREATE TABLE social_public_threads (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 -- Opaque ownership survives membership/user deletion; the departure trigger erases bytes.
 owner_user_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 captured_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source_url text,
 -- Canonical validated JSON bytes: keep the exact 64000-byte/hash boundary.
 payload text,
 payload_sha256 text,
 coverage text,
 message_count integer,
 reason text,
 PRIMARY KEY(workspace_id,id),
 CONSTRAINT social_public_thread_revision CHECK((reason IS NULL AND revision=1) OR (reason IS NOT NULL AND revision=2)),
 CONSTRAINT social_public_thread_lifetime CHECK(captured_at<=retained_at AND retained_at<expires_at AND expires_at>captured_at AND expires_at<=captured_at+interval '720 hours'),
 CONSTRAINT social_public_thread_reason CHECK(reason IN ('expired','removed')),
 CONSTRAINT social_public_thread_url CHECK(source_url IS NULL OR source_url ~ '^https://www[.]linkedin[.]com/feed/update/urn:li:activity:[0-9]{1,40}/$'),
 CONSTRAINT social_public_thread_hash CHECK(payload_sha256 IS NULL OR payload_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT social_public_thread_payload CHECK(payload IS NULL OR ((
  jsonb_typeof(payload::jsonb)='object' AND octet_length(payload)<=64000
  AND payload::jsonb->>'platform'='linkedin' AND payload::jsonb->>'visibility'='public_web'
  AND payload::jsonb->>'url'=source_url AND payload::jsonb->>'coverage'=coverage
  AND jsonb_typeof(payload::jsonb->'messages')='array' AND jsonb_array_length(payload::jsonb->'messages')=message_count) IS TRUE)),
 CONSTRAINT social_public_thread_live_shape CHECK(
  (reason IS NULL AND source_url IS NOT NULL AND payload IS NOT NULL AND payload_sha256 IS NOT NULL
   AND coverage IN ('partial','unknown') AND message_count BETWEEN 1 AND 50)
  OR (reason IS NOT NULL AND source_url IS NULL AND payload IS NULL AND payload_sha256 IS NULL AND coverage IS NULL AND message_count IS NULL))
);
CREATE INDEX social_public_thread_owner ON social_public_threads(workspace_id,owner_user_id,id);
CREATE INDEX social_public_thread_expiry ON social_public_threads(workspace_id,expires_at,id) WHERE reason IS NULL;
GRANT SELECT,INSERT,UPDATE ON social_public_threads TO app_runtime;
REVOKE DELETE ON social_public_threads FROM app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON social_public_threads TO migration;

CREATE FUNCTION social_public_thread_owner_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id AND user_id=NEW.owner_user_id AND status='active' AND role='admin' FOR SHARE;
 IF NOT FOUND OR NEW.reason IS NOT NULL OR NEW.revision<>1 OR NEW.captured_at>clock_timestamp()
  OR NEW.captured_at<clock_timestamp()-interval '720 hours' OR NEW.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'public thread retention requires current owner and time' USING ERRCODE='23514',CONSTRAINT='social_public_thread_owner_active';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER social_public_thread_owner_active AFTER INSERT ON social_public_threads
 FOR EACH ROW EXECUTE FUNCTION social_public_thread_owner_active();

CREATE FUNCTION social_public_thread_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id
  OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
  OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.retained_at IS DISTINCT FROM OLD.retained_at THEN
  RAISE EXCEPTION 'public thread identity and horizon are immutable' USING ERRCODE='23514',CONSTRAINT='social_public_thread_immutable';
 END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF OLD.reason IS NOT NULL OR NEW.reason IS NULL OR NEW.revision<>OLD.revision+1
  OR NEW.source_url IS NOT NULL OR NEW.payload IS NOT NULL OR NEW.payload_sha256 IS NOT NULL
  OR NEW.coverage IS NOT NULL OR NEW.message_count IS NOT NULL OR NEW.updated_at<OLD.updated_at THEN
  RAISE EXCEPTION 'public thread permits terminal erasure only' USING ERRCODE='23514',CONSTRAINT='social_public_thread_immutable';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER social_public_thread_immutable AFTER UPDATE ON social_public_threads
 FOR EACH ROW EXECUTE FUNCTION social_public_thread_immutable();

CREATE FUNCTION erase_departed_social_public_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='users' THEN
  UPDATE social_public_threads SET source_url=NULL,payload=NULL,payload_sha256=NULL,coverage=NULL,message_count=NULL,
   reason='removed',revision=revision+1,updated_at=clock_timestamp() WHERE owner_user_id=OLD.id AND reason IS NULL;
 ELSIF TG_OP='DELETE' OR NEW.status<>'active' OR NEW.role<>'admin' THEN
  UPDATE social_public_threads SET source_url=NULL,payload=NULL,payload_sha256=NULL,coverage=NULL,message_count=NULL,
   reason='removed',revision=revision+1,updated_at=clock_timestamp()
   WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id AND reason IS NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_public_thread_owner_departure AFTER UPDATE OF status,role OR DELETE ON workspace_memberships
 FOR EACH ROW EXECUTE FUNCTION erase_departed_social_public_owner();
CREATE TRIGGER social_public_thread_owner_deleted AFTER DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION erase_departed_social_public_owner();
