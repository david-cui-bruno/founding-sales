-- Kept research candidates are the active monitoring cohort. No CRM admission.
ALTER TABLE sourcing_candidates ADD COLUMN next_source_check_at timestamptz;
UPDATE sourcing_candidates
   SET next_source_check_at=CASE WHEN source_check IS NULL THEN now()
       ELSE (source_check->>'requestedAt')::timestamptz + interval '7 days' END
 WHERE status='kept';
ALTER TABLE sourcing_candidates ADD CONSTRAINT sourcing_monitoring_status
 CHECK ((status='kept') = (next_source_check_at IS NOT NULL));
CREATE INDEX sourcing_candidates_due ON sourcing_candidates(workspace_id,next_source_check_at,id)
 WHERE status='kept';
