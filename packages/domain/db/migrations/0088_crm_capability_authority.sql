-- changes: crm_business_policies, crm_mail_capture_controls, crm_extraction_purposes, crm_ask_purposes
-- Reviewed documentary authority is independently provisioned by trusted operations.
-- Application requests may reference it, never mint it. This migration enables nothing.
CREATE TABLE crm_capability_authority_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 capability text NOT NULL CHECK(capability IN ('metadata_review','mail_capture','mail_backfill','crm_extraction','ask_answer')),
 owner_user_id uuid NOT NULL, configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 authority_sha256 text NOT NULL CHECK(authority_sha256 ~ '^[a-f0-9]{64}$'),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384 AND receipt ?& ARRAY['id','configuration','configurationFingerprint','reviewedBy','reviewReference','verifiedAt','validUntil','proof'] AND receipt-ARRAY['id','configuration','configurationFingerprint','reviewedBy','reviewReference','verifiedAt','validUntil','proof']='{}'::jsonb),
 CONSTRAINT crm_capability_authority_body_free CHECK(
 jsonb_typeof(receipt->'configuration')='object' AND
 (receipt->'configuration')-ARRAY['capability','workspaceId','ownerUserId','revision','mailboxId','providerAccountId','generation','accountBinding','disclosureVersion','disclosureSha256','scopeDays','policyRevision','grantReceipt','providerPolicyReceipt','evaluationReceipt','releaseReceipt','captureVersion','scopeFingerprint','allocationFingerprint','endpointId','modelVersion','accessGrantVersion','dataHandlingVersion','dailyCeilingCents','monthlyCeilingCents','inputTokenPriceMicros','outputTokenPriceMicros','processorVersion','purpose','evaluationFingerprint','retrievalVersion','answerVersion','supportVersion','chunkerVersion']='{}'::jsonb AND
 jsonb_typeof(receipt->'proof')='object' AND
 (receipt->'proof')-ARRAY['evaluationKind','evaluationFingerprint','evaluationConfigurationFingerprint','evaluationReference','accessGrantReference','dataHandlingReference','providerAcceptanceReference','deletionAcceptanceReference','fundingReference','oauthGrantObservationId','release']='{}'::jsonb AND
 jsonb_typeof(receipt->'proof'->'release')='object' AND
 (receipt->'proof'->'release')-ARRAY['reference','implementationCommit','apiImageDigest','workerImageDigest','schemaVersion','nativeAcceptanceReference']='{}'::jsonb),
 reviewed_by uuid NOT NULL, review_reference text NOT NULL CHECK(length(review_reference) BETWEEN 1 AND 200),
 verified_at timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until>verified_at),
 revoked_at timestamptz, revocation_reference text CHECK(length(revocation_reference) BETWEEN 1 AND 200),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id), FOREIGN KEY(workspace_id,reviewed_by) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((revoked_at IS NULL)=(revocation_reference IS NULL)),
 CHECK(receipt->>'id'=id::text AND receipt->>'configurationFingerprint'=configuration_sha256 AND receipt->'configuration'->>'workspaceId'=workspace_id::text AND receipt->'configuration'->>'ownerUserId'=owner_user_id::text AND receipt->'configuration'->>'capability'=capability)
);
GRANT SELECT ON crm_capability_authority_receipts TO app_runtime,migration;
GRANT INSERT ON crm_capability_authority_receipts TO migration;
GRANT UPDATE(revoked_at,revocation_reference) ON crm_capability_authority_receipts TO migration;
CREATE FUNCTION crm_capability_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-authority:'||OLD.workspace_id::text||':'||OLD.id::text,0));
 IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revocation_reference IS NULL OR NEW.revoked_at<OLD.verified_at OR (to_jsonb(NEW)-ARRAY['revoked_at','revocation_reference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revocation_reference']) THEN RAISE EXCEPTION 'CRM authority is immutable except one revocation'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER crm_capability_authority_immutable BEFORE UPDATE OR DELETE ON crm_capability_authority_receipts FOR EACH ROW EXECUTE FUNCTION crm_capability_authority_immutable();
CREATE TABLE mailbox_oauth_grant_observations (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL, provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320), generation integer NOT NULL CHECK(generation>0),
 granted_scopes text[] NOT NULL CHECK(cardinality(granted_scopes) BETWEEN 1 AND 30), observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id), FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT ON mailbox_oauth_grant_observations TO app_runtime,migration;
CREATE FUNCTION crm_oauth_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OAuth observations are immutable'; END; $$;
CREATE TRIGGER crm_oauth_observation_immutable BEFORE UPDATE OR DELETE ON mailbox_oauth_grant_observations FOR EACH ROW EXECUTE FUNCTION crm_oauth_observation_immutable();
ALTER TABLE crm_business_policies ADD COLUMN authority_receipt_id uuid, ADD FOREIGN KEY(workspace_id,authority_receipt_id) REFERENCES crm_capability_authority_receipts(workspace_id,id);
ALTER TABLE crm_mail_capture_controls ADD COLUMN authority_receipt_id uuid, ADD FOREIGN KEY(workspace_id,authority_receipt_id) REFERENCES crm_capability_authority_receipts(workspace_id,id);
ALTER TABLE crm_extraction_purposes ADD COLUMN authority_receipt_id uuid, ADD FOREIGN KEY(workspace_id,authority_receipt_id) REFERENCES crm_capability_authority_receipts(workspace_id,id);
ALTER TABLE crm_ask_purposes ADD COLUMN authority_receipt_id uuid, ADD FOREIGN KEY(workspace_id,authority_receipt_id) REFERENCES crm_capability_authority_receipts(workspace_id,id);
