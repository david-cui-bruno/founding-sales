-- changes: opportunities
-- Preserve existing commercial stages with explicit legacy authority; new labels are nullable.
DROP INDEX opportunities_one_open_per_firm;
CREATE INDEX opportunities_open_by_firm ON opportunities(workspace_id,firm_id,id) WHERE status='open';
ALTER TABLE opportunities ADD COLUMN display_name text;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_display_name_bounded CHECK(display_name IS NULL OR (display_name=btrim(display_name) AND length(display_name) BETWEEN 1 AND 160));

-- Outreach control does not grant authority to move commercial stages.
ALTER TABLE opportunities ADD COLUMN stage_control_mode text NOT NULL DEFAULT 'legacy_rules';
ALTER TABLE opportunities ADD CONSTRAINT opportunities_stage_control_mode_known CHECK (stage_control_mode IN ('legacy_rules','human'));
