-- changes: social_publisher_credentials,social_buffer_publisher_runtime,social_standing_slots,social_standing_plans,workspace_memberships
-- Old ciphertext, snapshots and receipts remain solely for explicit rollback/recovery.
-- Overdue unknown writes are still writes: time never grants permission to cut over.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM social_standing_slots WHERE submission_marked_at IS NOT NULL AND state NOT IN ('published','cancelled','failed_known_not_submitted') AND COALESCE(snapshot->'binding'->>'adapter','')<>'buffer-linkedin-v1')
 OR EXISTS(SELECT 1 FROM social_deliveries WHERE submission_id IS NOT NULL AND state IN ('submitting','scheduled','unknown','cancellation_pending')) THEN
  RAISE EXCEPTION 'social_old_publisher_unresolved_attempts';
 END IF;
END $$;
CREATE TABLE social_publisher_credentials (
 workspace_id uuid NOT NULL,id uuid NOT NULL,owner_user_id uuid NOT NULL,account_id uuid NOT NULL,
 account_revision integer NOT NULL CHECK(account_revision>0),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 adapter text NOT NULL CHECK(adapter='buffer-linkedin-v1'),
 organization_id text NOT NULL CHECK(organization_id ~ '^[a-fA-F0-9]{24}$'),channel_id text NOT NULL CHECK(channel_id ~ '^[a-fA-F0-9]{24}$'),
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 300),encrypted_state bytea,
 state text NOT NULL CHECK(state IN ('usable','disconnected')),verified_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,account_id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES social_accounts(workspace_id,id) ON DELETE CASCADE,
 CHECK((state='usable')=(encrypted_state IS NOT NULL)),
 CHECK(encrypted_state IS NULL OR octet_length(encrypted_state) BETWEEN 29 AND 16384)
);
CREATE INDEX social_publisher_credentials_owner ON social_publisher_credentials(workspace_id,owner_user_id);
CREATE TABLE social_buffer_publisher_runtime (
 id text NOT NULL CHECK(id='buffer-linkedin-v1'),execution_side text NOT NULL CHECK(execution_side IN ('api','worker')),
 observed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(id,execution_side),
 CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '5 minutes')
);
GRANT SELECT,INSERT,UPDATE,DELETE ON social_publisher_credentials,social_buffer_publisher_runtime TO app_runtime,migration;
CREATE FUNCTION erase_social_publisher_owner_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM social_publisher_credentials WHERE workspace_id=OLD.workspace_id AND owner_user_id=OLD.user_id;
 ELSE
  IF NEW.status<>'active' OR NEW.role<>'admin' THEN
   UPDATE social_publisher_credentials SET encrypted_state=NULL,state='disconnected',revision=revision+1 WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND encrypted_state IS NOT NULL;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER social_publisher_credential_departure AFTER UPDATE OF status,role OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION erase_social_publisher_owner_credential();
ALTER TABLE social_standing_slots ADD COLUMN media_receipt_id text,ADD COLUMN observed_at timestamptz;
ALTER TABLE social_standing_slots ADD CONSTRAINT social_standing_receipt_size CHECK((receipt_id IS NULL OR length(receipt_id) BETWEEN 1 AND 300) AND (media_receipt_id IS NULL OR length(media_receipt_id) BETWEEN 1 AND 300));
ALTER TABLE social_standing_slots DROP CONSTRAINT social_standing_marked_attempt;
ALTER TABLE social_standing_slots ADD CONSTRAINT social_standing_marked_attempt CHECK(submission_marked_at IS NULL OR (snapshot IS NOT NULL AND fingerprint IS NOT NULL AND fingerprint ~ '^[a-f0-9]{64}$' AND post_id IS NOT NULL AND state IN ('submitting','scheduled','published','cancellation_pending','cancelled','unknown','failed_known_not_submitted')));
CREATE OR REPLACE FUNCTION fence_social_standing_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.owner_user_id,NEW.plan_id,NEW.plan_revision,NEW.local_week,NEW.ordinal,NEW.publish_at,NEW.attempt_id)
 IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.owner_user_id,OLD.plan_id,OLD.plan_revision,OLD.local_week,OLD.ordinal,OLD.publish_at,OLD.attempt_id)
 OR (OLD.generation_request_id IS NOT NULL AND NEW.generation_request_id IS DISTINCT FROM OLD.generation_request_id)
 OR (OLD.input_refs<>'[]'::jsonb AND NEW.input_refs IS DISTINCT FROM OLD.input_refs)
 OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
 OR (OLD.media_receipt_id IS NOT NULL AND NEW.media_receipt_id IS DISTINCT FROM OLD.media_receipt_id)
 OR (OLD.observed_at IS NOT NULL AND (NEW.observed_at IS NULL OR NEW.observed_at<OLD.observed_at))
 THEN RAISE EXCEPTION 'social_standing_identity_immutable'; END IF;
 IF OLD.submission_marked_at IS NOT NULL THEN
  IF NEW.submission_marked_at IS DISTINCT FROM OLD.submission_marked_at OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
   OR NEW.post_id IS DISTINCT FROM OLD.post_id OR NEW.revision<>OLD.revision
   OR NEW.state IN ('preparing','queued','held','skipped')
   OR (NEW.state='failed_known_not_submitted' AND (NEW.receipt_id IS NOT NULL OR NEW.media_receipt_id IS NOT NULL))
   OR (OLD.state IN ('published','cancelled','failed_known_not_submitted') AND NEW.state<>OLD.state)
   OR (NEW.text IS DISTINCT FROM OLD.text AND NEW.text IS NOT NULL)
   OR (NEW.image IS DISTINCT FROM OLD.image AND NEW.image IS NOT NULL)
   OR NEW.snapshot IS NULL
   OR (NEW.snapshot-'text'-'image') IS DISTINCT FROM (OLD.snapshot-'text'-'image')
   OR (CASE WHEN jsonb_typeof(NEW.snapshot->'image')='object' THEN (NEW.snapshot->'image')-'altText' ELSE NEW.snapshot->'image' END)
      IS DISTINCT FROM (CASE WHEN jsonb_typeof(OLD.snapshot->'image')='object' THEN (OLD.snapshot->'image')-'altText' ELSE OLD.snapshot->'image' END)
   OR (NEW.snapshot->'text' IS DISTINCT FROM OLD.snapshot->'text' AND NEW.snapshot->'text'<>'null'::jsonb)
   OR (NEW.snapshot->'image'->'altText' IS DISTINCT FROM OLD.snapshot->'image'->'altText' AND NEW.snapshot->'image'->>'altText'<>'')
  THEN RAISE EXCEPTION 'social_standing_submission_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- A Buffer connection requires an explicit owner save; never reinterpret old plans.
UPDATE social_standing_plans SET state='paused',revision=revision+1 WHERE configuration->'binding'->>'adapter' IS DISTINCT FROM 'buffer-linkedin-v1' AND state='active';
