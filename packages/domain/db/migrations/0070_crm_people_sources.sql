-- Additive CRM identities and selected source references; no operational identity rewrite.
CREATE TABLE crm_people (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id uuid,
  full_name text NOT NULL CHECK (btrim(full_name) <> '' AND length(full_name) <= 240),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE crm_legacy_contact_people (
  workspace_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  person_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, contact_id),
  UNIQUE (workspace_id, person_id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id,id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES crm_people(workspace_id,id)
);
CREATE TABLE crm_selected_sources (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  source_key_hash text NOT NULL CHECK (source_key_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','deleted','awaiting_recapture')),
  excerpt text,
  content_hash text,
  occurred_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE(workspace_id,owner_user_id,source_key_hash),
  FOREIGN KEY (workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
  FOREIGN KEY (workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
  CHECK ((availability = 'available') = (excerpt IS NOT NULL)),
  CHECK ((availability = 'available') = (content_hash IS NOT NULL)),
  CHECK ((availability = 'available') = (occurred_at IS NOT NULL)),
  CHECK (excerpt IS NULL OR (btrim(excerpt) <> '' AND length(excerpt) <= 20000)),
  CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX crm_selected_sources_person ON crm_selected_sources(workspace_id,person_id,id);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_people,crm_legacy_contact_people,crm_selected_sources TO app_runtime,migration;
