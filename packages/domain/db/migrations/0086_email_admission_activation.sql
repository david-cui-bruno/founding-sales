-- changes: outreach_email_admission_activation_receipts, outreach_email_admission_settings
-- Existing controls stay disabled. A documentary receipt never dispatches mail.
CREATE TABLE outreach_email_admission_activation_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,control_revision integer NOT NULL CHECK(control_revision>0),
 configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[a-f0-9]{64}$'),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=2097152),
 proof_sha256 text NOT NULL CHECK(proof_sha256 ~ '^[a-f0-9]{64}$'),recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT ON outreach_email_admission_activation_receipts TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_email_admission_activation_receipts TO migration;
ALTER TABLE outreach_email_admission_settings ADD COLUMN activation_receipt_id uuid,
 ADD CONSTRAINT outreach_admission_activation_receipt_fk FOREIGN KEY(workspace_id,activation_receipt_id) REFERENCES outreach_email_admission_activation_receipts(workspace_id,id);
DO $$ DECLARE old_guard text; BEGIN
 SELECT conname INTO STRICT old_guard FROM pg_constraint WHERE conrelid='outreach_email_admission_settings'::regclass AND contype='c' AND pg_get_constraintdef(oid)='CHECK ((NOT enabled))';
 EXECUTE format('ALTER TABLE outreach_email_admission_settings DROP CONSTRAINT %I',old_guard);
END $$;
ALTER TABLE outreach_email_admission_settings ADD CONSTRAINT outreach_admission_enabled_receipt CHECK(NOT enabled OR activation_receipt_id IS NOT NULL);
