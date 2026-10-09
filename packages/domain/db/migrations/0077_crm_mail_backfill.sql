-- #484 provisional77: integration owner assigns final migration order.
-- No source text, participant address, token or provider credentials.
CREATE TABLE crm_mail_imports (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL, owner_user_id uuid NOT NULL,
 provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320),
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 generation integer NOT NULL CHECK(generation>0),
 controls_revision integer NOT NULL CHECK(controls_revision>0), policy_revision integer NOT NULL CHECK(policy_revision>0),
 from_at timestamptz NOT NULL, to_at timestamptz NOT NULL,
 history_anchor text CHECK(history_anchor ~ '^[0-9]{1,20}$'),
 history_cursor text CHECK(history_cursor ~ '^[0-9]{1,20}$'),
 history_complete boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','partial','complete','blocked')),
 reason text CHECK(reason ~ '^[a-z][a-z0-9_]{0,99}$'),
 completed_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,mailbox_id,account_binding,generation,controls_revision,policy_revision),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(from_at<to_at AND to_at-from_at=interval '90 days'),
 CHECK((history_anchor IS NULL)=(history_cursor IS NULL)),
 CHECK(NOT history_complete OR history_anchor IS NOT NULL),
 CHECK((state='complete')=(completed_at IS NOT NULL)),
 CHECK(state<>'complete' OR history_complete)
);
CREATE TABLE crm_mail_import_slices (
 workspace_id uuid NOT NULL, import_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 89),
 from_epoch_seconds bigint NOT NULL, to_epoch_seconds bigint NOT NULL,
 next_page_token text CHECK(length(next_page_token) BETWEEN 1 AND 2000),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
 PRIMARY KEY(workspace_id,import_id,ordinal),
 FOREIGN KEY(workspace_id,import_id) REFERENCES crm_mail_imports(workspace_id,id) ON DELETE CASCADE,
 CHECK(to_epoch_seconds-from_epoch_seconds=86400)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_imports,crm_mail_import_slices TO app_runtime,migration;
