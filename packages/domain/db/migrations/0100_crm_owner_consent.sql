-- changes: crm_business_policies, crm_mail_capture_controls, crm_extraction_purposes, crm_ask_purposes, crm_mail_imports
-- Owner decisions replace live per-release authority. Historical receipt rows are unchanged.
CREATE TABLE crm_capability_owner_approvals (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL, capability text NOT NULL CHECK(capability IN ('metadata_review','mail_capture','mail_backfill','crm_extraction','ask_answer')),
 configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 quality_tier text NOT NULL CHECK(quality_tier IN ('acquisition','provisional_owner','representative')),
 critical_controls_attested boolean NOT NULL DEFAULT false, model_integration_attested boolean NOT NULL DEFAULT false,
 evaluation_reference text CHECK(length(evaluation_reference) BETWEEN 1 AND 200),
 limitations text[] NOT NULL DEFAULT '{}', approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(limitations <@ ARRAY['representative_quality_unverified','limited_business_examples','vector_quality_unverified']::text[])
);
GRANT SELECT,INSERT ON crm_capability_owner_approvals TO app_runtime,migration;
CREATE FUNCTION crm_owner_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Owner approval audit is immutable'; END; $$;
CREATE TRIGGER crm_owner_approval_immutable BEFORE UPDATE OR DELETE ON crm_capability_owner_approvals FOR EACH ROW EXECUTE FUNCTION crm_owner_approval_immutable();
ALTER TABLE crm_business_policies ADD COLUMN owner_approval_id uuid, ADD FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id);
ALTER TABLE crm_mail_capture_controls ADD COLUMN owner_approval_id uuid, ADD FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id);
ALTER TABLE crm_extraction_purposes ADD COLUMN owner_approval_id uuid, ADD FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id);
ALTER TABLE crm_ask_purposes ADD COLUMN owner_approval_id uuid, ADD FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id);
ALTER TABLE crm_mail_capture_controls ALTER COLUMN grant_receipt DROP NOT NULL, ALTER COLUMN provider_policy_receipt DROP NOT NULL, ALTER COLUMN evaluation_receipt DROP NOT NULL, ALTER COLUMN release_receipt DROP NOT NULL;
ALTER TABLE crm_mail_imports ADD COLUMN owner_approval_id uuid, ADD FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id);
