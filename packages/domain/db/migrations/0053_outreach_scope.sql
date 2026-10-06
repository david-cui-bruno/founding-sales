-- changes: sequence_enrollments, mail_message_matches, mail_reply_confirmations, step_executions
CREATE TABLE outreach_plans (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 firm_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 qualification_run_id uuid NOT NULL,
 lane text NOT NULL CHECK(lane IN ('call_first','email_first')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','reply_pending','manual','booked','completed','stopped')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,id,firm_id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE,
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,candidate_id,qualification_run_id) REFERENCES sourcing_qualification_runs(workspace_id,candidate_id,id)
);
CREATE UNIQUE INDEX outreach_plans_one_active_firm ON outreach_plans(workspace_id,firm_id) WHERE state IN ('active','reply_pending','manual','booked');
ALTER TABLE sequence_enrollments ALTER COLUMN opportunity_id DROP NOT NULL,
 ADD COLUMN outreach_plan_id uuid,
 ADD CONSTRAINT enrollment_one_authority CHECK((opportunity_id IS NOT NULL)::int+(outreach_plan_id IS NOT NULL)::int=1),
 ADD CONSTRAINT enrollment_outreach_firm FOREIGN KEY(workspace_id,outreach_plan_id,firm_id) REFERENCES outreach_plans(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
GRANT SELECT,INSERT,UPDATE,DELETE ON outreach_plans TO app_runtime,migration;

ALTER TABLE mail_message_matches ALTER COLUMN opportunity_id DROP NOT NULL,
 ADD COLUMN outreach_plan_id uuid,
 ADD CONSTRAINT mail_match_one_authority CHECK((opportunity_id IS NOT NULL)::int+(outreach_plan_id IS NOT NULL)::int=1),
 ADD CONSTRAINT mail_match_outreach_firm FOREIGN KEY(workspace_id,outreach_plan_id,firm_id) REFERENCES outreach_plans(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
CREATE UNIQUE INDEX mail_message_matches_one_per_outreach ON mail_message_matches(workspace_id,mail_message_id,outreach_plan_id) WHERE outreach_plan_id IS NOT NULL;

ALTER TABLE mail_reply_confirmations ALTER COLUMN opportunity_id DROP NOT NULL,
 ADD COLUMN outreach_plan_id uuid,
 ADD CONSTRAINT reply_confirmation_one_authority CHECK((opportunity_id IS NOT NULL)::int+(outreach_plan_id IS NOT NULL)::int=1),
 ADD CONSTRAINT reply_confirmation_outreach_firm FOREIGN KEY(workspace_id,outreach_plan_id,firm_id) REFERENCES outreach_plans(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mail_reply_confirmations DROP CONSTRAINT mail_reply_confirmations_consequences_known,
 ADD CONSTRAINT mail_reply_confirmations_consequences_known CHECK(consequences <@ ARRAY['opportunity_manual','outreach_manual','callback_committed','handle_suppressed','firm_suppressed','holds_released','today_item_completed']::text[]);
-- Preserve sequence history when contacts and their firm are merged atomically.
ALTER TABLE sequence_enrollments DROP CONSTRAINT sequence_enrollments_contact_fkey,
 ADD CONSTRAINT sequence_enrollments_contact_fkey FOREIGN KEY(workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 DROP CONSTRAINT sequence_enrollments_opportunity_fkey,
 ADD CONSTRAINT sequence_enrollments_opportunity_fkey FOREIGN KEY(workspace_id,opportunity_id,firm_id) REFERENCES opportunities(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE step_executions DROP CONSTRAINT step_executions_contact_fkey,
 ADD CONSTRAINT step_executions_contact_fkey FOREIGN KEY(workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 DROP CONSTRAINT step_executions_enrollment_fkey,
 ADD CONSTRAINT step_executions_enrollment_fkey FOREIGN KEY(workspace_id,enrollment_id,firm_id) REFERENCES sequence_enrollments(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
