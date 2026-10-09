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
-- Provisional append to77, operator configuration only, no enabling public command.
CREATE TABLE crm_mail_import_allocations (
 workspace_id uuid NOT NULL, mailbox_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 owner_user_id uuid NOT NULL, account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'), generation integer NOT NULL CHECK(generation>0),
 project_hash text NOT NULL CHECK(project_hash ~ '^[a-f0-9]{64}$'), user_hash text NOT NULL CHECK(user_hash ~ '^[a-f0-9]{64}$'),
 user_limit_units integer NOT NULL CHECK(user_limit_units BETWEEN 1 AND 2147483647),
 project_limit_units integer NOT NULL CHECK(project_limit_units BETWEEN 1 AND 2147483647),
 user_headroom_units integer NOT NULL CHECK(user_headroom_units>=0 AND user_headroom_units<user_limit_units),
 project_headroom_units integer NOT NULL CHECK(project_headroom_units>=0 AND project_headroom_units<project_limit_units),
 profile_units integer NOT NULL CHECK(profile_units BETWEEN 1 AND 1000000),
 list_units integer NOT NULL CHECK(list_units BETWEEN 1 AND 1000000),
 history_units integer NOT NULL CHECK(history_units BETWEEN 1 AND 1000000),
 metadata_units integer NOT NULL CHECK(metadata_units BETWEEN 1 AND 1000000),
 body_units integer NOT NULL CHECK(body_units BETWEEN 1 AND 1000000),
 verification_sha256 text NOT NULL CHECK(verification_sha256 ~ '^[a-f0-9]{64}$'), verified_until timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,mailbox_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
CREATE TABLE crm_mail_import_read_reservations (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), import_id uuid NOT NULL,
 project_hash text NOT NULL CHECK(project_hash ~ '^[a-f0-9]{64}$'), user_hash text NOT NULL CHECK(user_hash ~ '^[a-f0-9]{64}$'),
 allocation_revision integer NOT NULL CHECK(allocation_revision>0),
 method text NOT NULL CHECK(method IN ('profile','list','history','metadata','body')),
 units integer NOT NULL CHECK(units BETWEEN 1 AND 1000000),
 state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','observed')),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), observed_at timestamptz,
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,import_id) REFERENCES crm_mail_imports(workspace_id,id),
 CHECK((state='observed')=(observed_at IS NOT NULL))
);
CREATE INDEX crm_mail_import_read_project_window ON crm_mail_import_read_reservations(project_hash,reserved_at);
CREATE INDEX crm_mail_import_read_user_window ON crm_mail_import_read_reservations(user_hash,reserved_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_import_allocations TO app_runtime,migration;
-- Ledger is append/read + monotonic observed marker, retained after source deletion.
GRANT SELECT,INSERT,UPDATE ON crm_mail_import_read_reservations TO app_runtime,migration;
