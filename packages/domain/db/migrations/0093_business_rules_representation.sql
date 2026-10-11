-- changes: crm_mail_sources, crm_business_correspondent_rules, crm_business_conversations, crm_business_decision_revisions
ALTER TABLE crm_mail_sources ADD COLUMN representation_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(representation_diagnostics)='array');
CREATE TABLE crm_business_correspondent_rules (
 workspace_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 endpoint text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('include','exclude')),
 revision integer NOT NULL CHECK(revision>0),
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,mailbox_id,account_binding,endpoint),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_business_correspondent_rules TO app_runtime,migration;
ALTER TABLE crm_business_conversations ADD COLUMN explicit_selected_at timestamptz;
ALTER TABLE crm_business_conversations DROP CONSTRAINT crm_business_conversations_check1;
ALTER TABLE crm_business_conversations ADD CONSTRAINT crm_business_conversations_check1 CHECK(decision_revision<>0 OR human_decision IS NULL);
ALTER TABLE crm_business_decision_revisions DROP CONSTRAINT crm_business_decision_revisions_decision_check;
ALTER TABLE crm_business_decision_revisions ADD CONSTRAINT crm_business_decision_revisions_decision_check CHECK(decision IN ('include','exclude','clear'));
ALTER TABLE crm_mail_sources ADD COLUMN provider_origin text NOT NULL DEFAULT 'unknown' CHECK(provider_origin IN ('received','sent','imported','unknown'));
