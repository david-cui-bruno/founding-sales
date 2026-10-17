-- changes: crm_identity_endpoints, linkedin_route_refusals
-- Supported profile assertions reuse source-versioned endpoint claims and their deletion closure.
-- This grants no invitation/DM channel and does not restore removed legacy sequence steps.
ALTER TABLE crm_identity_endpoints DROP CONSTRAINT crm_identity_endpoints_kind_check;
ALTER TABLE crm_identity_endpoints ADD CONSTRAINT crm_identity_endpoints_kind_check
 CHECK(kind IN ('email','phone','linkedin'));

CREATE TABLE linkedin_route_refusals (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 person_id uuid NOT NULL,
 firm_id uuid NOT NULL,
 endpoint_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 claim_revision integer NOT NULL CHECK(claim_revision>0),
 relationship_id uuid NOT NULL,
 relationship_revision integer NOT NULL CHECK(relationship_revision>0),
 scope text NOT NULL CHECK(scope IN ('person','firm','ambiguous')),
 actor_user_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,endpoint_id) REFERENCES crm_identity_endpoints(workspace_id,id),
 FOREIGN KEY(workspace_id,claim_id,claim_revision) REFERENCES crm_endpoint_claim_revisions(workspace_id,claim_id,revision),
 FOREIGN KEY(workspace_id,relationship_id,relationship_revision) REFERENCES crm_relationship_revisions(workspace_id,relationship_id,revision),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE INDEX linkedin_route_refusals_person ON linkedin_route_refusals(workspace_id,person_id);
CREATE INDEX linkedin_route_refusals_firm ON linkedin_route_refusals(workspace_id,firm_id);
GRANT SELECT,INSERT ON linkedin_route_refusals TO app_runtime,migration;
REVOKE UPDATE,DELETE,TRUNCATE ON linkedin_route_refusals FROM app_runtime,migration;
