-- Retain selected notes for a person OR a firm, never a fictional person.
ALTER TABLE crm_selected_sources ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE crm_selected_sources ADD COLUMN firm_id uuid;
ALTER TABLE crm_selected_sources ADD CONSTRAINT crm_selected_sources_firm_fk FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id);
ALTER TABLE crm_selected_sources ADD CONSTRAINT crm_selected_sources_subject_xor CHECK ((person_id IS NOT NULL) <> (firm_id IS NOT NULL));
-- Explicit evidence-backed relationships; no operational contact or route rewrites.
CREATE TABLE crm_relationships (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('current','historical','unknown')),
 start_date date,
 end_date date,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 context_review text NOT NULL DEFAULT 'current' CHECK(context_review IN ('current','required')),
 source_invalidated boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date)
);
CREATE INDEX crm_relationships_person ON crm_relationships(workspace_id,person_id,id);
CREATE TABLE crm_relationship_revisions (
 workspace_id uuid NOT NULL,
 relationship_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('current','historical','unknown')),
 start_date date,
 end_date date,
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 actor_user_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,relationship_id,revision),
 FOREIGN KEY(workspace_id,relationship_id) REFERENCES crm_relationships(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_relationships TO app_runtime,migration;
GRANT SELECT,INSERT ON crm_relationship_revisions TO app_runtime,migration;
CREATE TABLE crm_source_relationship_contexts (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 relationship_id uuid NOT NULL,
 relationship_revision integer NOT NULL CHECK(relationship_revision>0),
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 review text NOT NULL DEFAULT 'current' CHECK(review IN ('current','required')),
 PRIMARY KEY(workspace_id,id),
 CONSTRAINT crm_source_relationship_conte_workspace_id_source_id_relati_key UNIQUE(workspace_id,source_id,source_revision,relationship_id,relationship_revision),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,relationship_id,relationship_revision) REFERENCES crm_relationship_revisions(workspace_id,relationship_id,revision),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_source_relationship_contexts TO app_runtime,migration;
CREATE TABLE crm_identity_endpoints (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('email','phone')),
 value text,
 value_hash text NOT NULL CHECK(value_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,kind,value_hash),
 CHECK(value IS NULL OR (btrim(value)<>'' AND length(value)<=320))
);
CREATE TABLE crm_endpoint_claims (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 endpoint_id uuid NOT NULL,
 person_id uuid,
 firm_id uuid,
 shared boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('current','historical','unknown')),
 start_date date,
 end_date date,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 source_invalidated boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,endpoint_id) REFERENCES crm_identity_endpoints(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 CHECK((person_id IS NOT NULL AND firm_id IS NULL AND NOT shared) OR (person_id IS NULL AND firm_id IS NOT NULL AND shared)),
 CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date)
);
CREATE INDEX crm_endpoint_claims_endpoint ON crm_endpoint_claims(workspace_id,endpoint_id,id);
CREATE TABLE crm_endpoint_claim_revisions (
 workspace_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 endpoint_id uuid NOT NULL,
 person_id uuid,
 firm_id uuid,
 shared boolean NOT NULL,
 status text NOT NULL CHECK(status IN ('current','historical','unknown')),
 start_date date,
 end_date date,
 source_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 actor_user_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,claim_id,revision),
 FOREIGN KEY(workspace_id,claim_id) REFERENCES crm_endpoint_claims(workspace_id,id),
 FOREIGN KEY(workspace_id,endpoint_id) REFERENCES crm_identity_endpoints(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_selected_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((person_id IS NOT NULL AND firm_id IS NULL AND NOT shared) OR (person_id IS NULL AND firm_id IS NOT NULL AND shared)),
 CHECK(start_date IS NULL OR end_date IS NULL OR start_date<=end_date)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_identity_endpoints,crm_endpoint_claims TO app_runtime,migration;
GRANT SELECT,INSERT ON crm_endpoint_claim_revisions TO app_runtime,migration;
