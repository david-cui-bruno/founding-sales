-- changes: meeting_follow_through
-- Existing plans retain their existing template-only authority, never a fabricated human approval.
ALTER TABLE meeting_follow_through
 ADD COLUMN approval_mode text NOT NULL DEFAULT 'legacy_template' CHECK(approval_mode IN ('legacy_template','human')),
 ADD COLUMN approval jsonb CHECK(approval IS NULL OR jsonb_typeof(approval)='object'),
 ADD COLUMN fact_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(fact_refs)='array' AND jsonb_array_length(fact_refs)<=20);
ALTER TABLE meeting_follow_through ALTER COLUMN approval_mode SET DEFAULT 'human';
