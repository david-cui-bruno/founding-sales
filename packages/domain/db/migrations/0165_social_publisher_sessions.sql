-- changes: social_publisher_sessions, social_publisher_runtime
-- Session state is envelope-encrypted by the browser runtime, never JSON cookies.
-- Account metadata alone is not a usable browser connection.
CREATE TABLE social_publisher_sessions (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 account_id uuid NOT NULL,
 account_revision integer NOT NULL CHECK(account_revision>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 300),
 encrypted_state bytea,
 state text NOT NULL CHECK(state IN ('usable','expired','disconnected')),
 verified_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,account_id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES social_accounts(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT social_publisher_sessions_credentials_shape CHECK((state='usable')=(encrypted_state IS NOT NULL)),
 CONSTRAINT social_publisher_sessions_expiry CHECK(expires_at>verified_at AND expires_at<=verified_at+interval '30 days'),
 CONSTRAINT social_publisher_sessions_encrypted_state_size CHECK(encrypted_state IS NULL OR octet_length(encrypted_state) BETWEEN 29 AND 524288)
);
CREATE INDEX social_publisher_sessions_owner ON social_publisher_sessions(workspace_id,owner_user_id);
CREATE TABLE social_publisher_runtime (
 id text NOT NULL CHECK(id='linkedin-web-chromium-v1'),
 execution_side text NOT NULL CHECK(execution_side IN ('api','worker')),
 observed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 chromium_version text NOT NULL CHECK(length(chromium_version) BETWEEN 1 AND 100),
 PRIMARY KEY(id,execution_side),
 CONSTRAINT social_publisher_runtime_expiry CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '5 minutes')
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_publisher_sessions TO app_runtime,migration;
GRANT SELECT,INSERT,UPDATE,DELETE ON social_publisher_runtime TO app_runtime,migration;
-- Erase authentication on owner departure, even though remote schedules survive.
CREATE FUNCTION erase_social_publisher_owner_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'active' OR NEW.role<>'admin' THEN
  UPDATE social_publisher_sessions SET encrypted_state=NULL,state='disconnected',revision=revision+1
  WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND encrypted_state IS NOT NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER social_publisher_owner_departure AFTER UPDATE OF status,role ON workspace_memberships
 FOR EACH ROW EXECUTE FUNCTION erase_social_publisher_owner_session();
CREATE FUNCTION erase_social_publisher_deleted_owner_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM social_publisher_sessions WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
 RETURN OLD;
END;
$$;
CREATE TRIGGER social_publisher_owner_deleted BEFORE DELETE ON workspace_memberships
 FOR EACH ROW EXECUTE FUNCTION erase_social_publisher_deleted_owner_session();
