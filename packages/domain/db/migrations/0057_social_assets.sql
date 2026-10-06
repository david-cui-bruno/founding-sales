CREATE TABLE social_library_usage (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 bytes_reserved bigint NOT NULL DEFAULT 0 CHECK(bytes_reserved BETWEEN 0 AND 1073741824)
);
CREATE TABLE social_assets (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL REFERENCES users(id), current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','deleted')),
 origin jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE social_asset_objects (
 workspace_id uuid NOT NULL, asset_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 upload_id uuid NOT NULL DEFAULT gen_random_uuid(), object_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('original','derivative')), state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','deleted')),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 20971520),
 mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','image/heic')), width integer, height integer,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', completed_at timestamptz,
 PRIMARY KEY(workspace_id,asset_id,version), UNIQUE(workspace_id,upload_id),
 FOREIGN KEY(workspace_id,asset_id) REFERENCES social_assets(workspace_id,id),
 CHECK((kind='original' AND version=1) OR (kind='derivative' AND version>1 AND bytes<=5242880 AND mime IN ('image/png','image/jpeg') AND width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096 AND width IS NOT NULL AND height IS NOT NULL))
);
CREATE UNIQUE INDEX social_asset_pending ON social_asset_objects(workspace_id,asset_id) WHERE state='uploading';
CREATE TABLE social_object_deletions (
 workspace_id uuid NOT NULL, asset_id uuid NOT NULL, version integer NOT NULL, object_key text NOT NULL,
 bytes integer NOT NULL CHECK(bytes>0), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 PRIMARY KEY(workspace_id,asset_id,version),
 FOREIGN KEY(workspace_id,asset_id,version) REFERENCES social_asset_objects(workspace_id,asset_id,version)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_library_usage,social_assets,social_asset_objects,social_object_deletions TO app_runtime,migration;
