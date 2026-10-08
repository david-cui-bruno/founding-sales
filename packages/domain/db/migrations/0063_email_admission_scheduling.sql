-- changes: sourcing_qualification_runs, outreach_email_admission_settings
-- Independent from call admission. A new run or control revision earns a fresh
-- evaluation; unchanged permanent uncertainty does not spin or buy research.
ALTER TABLE sourcing_qualification_runs
 ADD COLUMN email_admission_control_revision integer,
 ADD COLUMN email_admission_attempts integer NOT NULL DEFAULT 0 CHECK(email_admission_attempts BETWEEN 0 AND 7),
 ADD COLUMN email_admission_reason text,
 ADD COLUMN email_admission_next_at timestamptz;
ALTER TABLE outreach_email_admission_settings ADD COLUMN batch_last_at timestamptz;
CREATE INDEX outreach_email_admission_due ON outreach_email_admission_settings(batch_last_at,workspace_id) WHERE enabled;
