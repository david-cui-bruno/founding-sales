-- Acquisition configuration is independent of mail matching and sending controls.
CREATE TABLE crm_business_policies (
 workspace_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320),
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 generation integer NOT NULL CHECK(generation>0),
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT false,
 disclosure_version text,
 disclosure_sha256 text,
 PRIMARY KEY(workspace_id,mailbox_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((disclosure_version IS NULL AND disclosure_sha256 IS NULL) OR (disclosure_version IS NOT NULL AND disclosure_sha256 IS NOT NULL AND length(disclosure_version) BETWEEN 1 AND 100 AND disclosure_sha256 ~ '^[a-f0-9]{64}$'))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_business_policies TO app_runtime,migration;
-- Only proven, allowlisted metadata. Provider bodies remain outside this store.
CREATE TABLE crm_business_conversations (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 provider_thread_id text NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 320),
 subject text NOT NULL CHECK(length(subject)<=500),
 participants jsonb NOT NULL CHECK(jsonb_typeof(participants)='array' AND jsonb_array_length(participants)<=50 AND NOT jsonb_path_exists(participants,'$[*] ? (@.type() != "string")') AND length(participants::text)<=17000),
 latest_provider_at timestamptz,
 metadata_availability text NOT NULL DEFAULT 'available' CHECK(metadata_availability IN ('available','deleted')),
 category text NOT NULL CHECK(category IN ('business','uncertain','personal','newsletter','receipt','routine_support')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 100),
 classifier_version text NOT NULL CHECK(length(classifier_version) BETWEEN 1 AND 100),
 CHECK((metadata_availability<>'deleted' AND latest_provider_at IS NOT NULL) OR (metadata_availability='deleted' AND subject='' AND participants='[]'::jsonb AND latest_provider_at IS NULL)),
 metadata_revision integer NOT NULL DEFAULT 1 CHECK(metadata_revision>0),
 metadata_hash text NOT NULL CHECK(metadata_hash ~ '^[a-f0-9]{64}$'),
 decision_revision integer NOT NULL DEFAULT 0 CHECK(decision_revision>=0),
 human_decision text CHECK(human_decision IN ('include','exclude')),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,mailbox_id,account_binding,provider_thread_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK((decision_revision=0 AND human_decision IS NULL) OR (decision_revision<>0 AND human_decision IS NOT NULL))
);
CREATE INDEX crm_business_conversations_page ON crm_business_conversations(workspace_id,mailbox_id,account_binding,id);
CREATE TABLE crm_business_decision_revisions (
 workspace_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 metadata_revision integer NOT NULL CHECK(metadata_revision>0),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 actor_user_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('include','exclude')),
 PRIMARY KEY(workspace_id,conversation_id,revision),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES crm_business_conversations(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_business_conversations TO app_runtime,migration;
GRANT SELECT,INSERT ON crm_business_decision_revisions TO app_runtime,migration;
