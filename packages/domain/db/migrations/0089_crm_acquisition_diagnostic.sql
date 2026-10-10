-- changes: crm_mail_sources
-- Diagnostic grants never enable ordinary acquisition or establish actual acceptance.
CREATE FUNCTION crm_acquisition_diagnostic_document_body_free(doc jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_typeof(doc)='object' AND doc-ARRAY['id','purpose','workspaceId','mailboxId','ownerUserId','providerAccountId','accountBinding','generation','oauthGrantObservationId','databaseInstanceArn','databaseSecretArn','databaseEndpoint','ecsClusterArn','deploymentIdentity','workerDeploymentIdentity','environmentId','databaseName','implementationCommit','apiImageDigest','workerImageDigest','schemaVersion','releaseReference','disclosureVersion','disclosureSha256','consentReference','providerPolicyReference','reviewedBy','reviewReference','verifiedAt','validUntil','maxReads','maxUnits','metadataUnits','bodyUnits','messages']='{}'::jsonb AND (NOT doc ? 'messages' OR (jsonb_typeof(doc->'messages')='array' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'messages') m WHERE jsonb_typeof(m)<>'object' OR m-ARRAY['messageId','threadId','origin','fromAt','toAt']<>'{}'::jsonb))); $$;
CREATE TABLE crm_acquisition_diagnostic_authorizations (
 workspace_id uuid NOT NULL, id uuid NOT NULL, owner_user_id uuid NOT NULL, mailbox_id uuid NOT NULL,
 authorization_sha256 text NOT NULL CONSTRAINT crm_diagnostic_hash CHECK(authorization_sha256 ~ '^[a-f0-9]{64}$'),
 authorization_document jsonb NOT NULL CONSTRAINT crm_diagnostic_document CHECK(COALESCE(jsonb_typeof(authorization_document)='object' AND octet_length(authorization_document::text)<=16384 AND authorization_document->>'purpose'='acquisition_acceptance' AND crm_acquisition_diagnostic_document_body_free(authorization_document) AND authorization_document->>'id'=id::text AND authorization_document->>'workspaceId'=workspace_id::text AND authorization_document->>'ownerUserId'=owner_user_id::text AND authorization_document->>'mailboxId'=mailbox_id::text,false)),
 verified_at timestamptz NOT NULL, valid_until timestamptz NOT NULL CONSTRAINT crm_diagnostic_dates CHECK(valid_until>verified_at),
 revoked_at timestamptz, revocation_reference text CONSTRAINT crm_diagnostic_revocation_reference CHECK(length(revocation_reference) BETWEEN 1 AND 200),
 CONSTRAINT crm_diagnostic_authorization_pk PRIMARY KEY(workspace_id,id), CONSTRAINT crm_diagnostic_mailbox_fk FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id), CONSTRAINT crm_diagnostic_owner_fk FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id), CONSTRAINT crm_diagnostic_revocation_pair CHECK((revoked_at IS NULL)=(revocation_reference IS NULL))
);
GRANT SELECT ON crm_acquisition_diagnostic_authorizations TO app_runtime,migration;
GRANT INSERT ON crm_acquisition_diagnostic_authorizations TO migration;
GRANT UPDATE(revoked_at,revocation_reference) ON crm_acquisition_diagnostic_authorizations TO migration;
CREATE FUNCTION crm_acquisition_diagnostic_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('crm-diagnostic:'||OLD.workspace_id::text||':'||OLD.id::text,0));
 IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revocation_reference IS NULL OR (to_jsonb(NEW)-ARRAY['revoked_at','revocation_reference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revocation_reference']) THEN RAISE EXCEPTION 'Diagnostic authorization immutable except revocation'; END IF;
 RETURN NEW; END; $$;
CREATE TRIGGER crm_acquisition_diagnostic_immutable BEFORE UPDATE OR DELETE ON crm_acquisition_diagnostic_authorizations FOR EACH ROW EXECUTE FUNCTION crm_acquisition_diagnostic_immutable();
CREATE TABLE crm_acquisition_diagnostic_reads (
 workspace_id uuid NOT NULL, authorization_id uuid NOT NULL, message_id text NOT NULL CONSTRAINT crm_diagnostic_message CHECK(message_id ~ '^[A-Za-z0-9_-]{1,128}$'), operation text NOT NULL CONSTRAINT crm_diagnostic_operation CHECK(operation IN ('profile_before','metadata','body','profile_after')),
 transport text NOT NULL CONSTRAINT crm_diagnostic_transport CHECK(transport IN ('controlled','actual_transport')), state text NOT NULL CONSTRAINT crm_diagnostic_state CHECK(state IN ('calling','observed','unknown')), units integer NOT NULL CONSTRAINT crm_diagnostic_units CHECK(units BETWEEN 1 AND 1000), observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT crm_diagnostic_operation_units CHECK(units NOT BETWEEN 1 AND 1000 OR (operation IN ('profile_before','profile_after') AND units=1) OR (operation IN ('metadata','body') AND units=5)), CONSTRAINT crm_diagnostic_read_pk PRIMARY KEY(workspace_id,authorization_id,message_id,operation), CONSTRAINT crm_diagnostic_read_authorization_fk FOREIGN KEY(workspace_id,authorization_id) REFERENCES crm_acquisition_diagnostic_authorizations(workspace_id,id)
);
GRANT SELECT,INSERT ON crm_acquisition_diagnostic_reads TO app_runtime,migration;
GRANT UPDATE(state) ON crm_acquisition_diagnostic_reads TO app_runtime,migration;
CREATE FUNCTION crm_acquisition_diagnostic_read_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'calling' OR NEW.state NOT IN ('observed','unknown') OR (to_jsonb(OLD)-'state') IS DISTINCT FROM (to_jsonb(NEW)-'state') THEN RAISE EXCEPTION 'Diagnostic read already dispatched'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER crm_acquisition_diagnostic_read_immutable BEFORE UPDATE OR DELETE ON crm_acquisition_diagnostic_reads FOR EACH ROW EXECUTE FUNCTION crm_acquisition_diagnostic_read_immutable();
ALTER TABLE crm_mail_sources ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE crm_mail_sources ADD COLUMN diagnostic_authorization_id uuid, ADD CONSTRAINT crm_mail_source_diagnostic_fk FOREIGN KEY(workspace_id,diagnostic_authorization_id) REFERENCES crm_acquisition_diagnostic_authorizations(workspace_id,id), ADD CONSTRAINT crm_mail_source_context_authority CHECK((conversation_id IS NOT NULL AND diagnostic_authorization_id IS NULL) OR (conversation_id IS NULL AND diagnostic_authorization_id IS NOT NULL));
