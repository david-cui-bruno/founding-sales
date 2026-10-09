-- changes: mail_messages
-- Full-body acquisition has independent authority. Metadata review never enables it.
CREATE TABLE crm_mail_capture_controls (
 workspace_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320),
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 generation integer NOT NULL CHECK(generation > 0),
 revision integer NOT NULL CHECK(revision > 0),
 enabled boolean NOT NULL DEFAULT false,
 policy_revision integer NOT NULL CHECK(policy_revision > 0),
 disclosure_version text NOT NULL CHECK(length(disclosure_version) BETWEEN 1 AND 100),
 disclosure_sha256 text NOT NULL CHECK(disclosure_sha256 ~ '^[a-f0-9]{64}$'),
 grant_receipt text NOT NULL CHECK(length(grant_receipt) BETWEEN 1 AND 200),
 provider_policy_receipt text NOT NULL CHECK(length(provider_policy_receipt) BETWEEN 1 AND 200),
 evaluation_receipt text NOT NULL CHECK(length(evaluation_receipt) BETWEEN 1 AND 200),
 release_receipt text NOT NULL CHECK(length(release_receipt) BETWEEN 1 AND 200),
 PRIMARY KEY(workspace_id,mailbox_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_capture_controls TO app_runtime,migration;
ALTER TABLE mail_messages ADD COLUMN business_capture_authorized boolean NOT NULL DEFAULT false;
ALTER TABLE mail_messages DROP CONSTRAINT mail_messages_body_needs_match;
ALTER TABLE mail_messages ADD CONSTRAINT mail_messages_body_needs_match CHECK(metadata_only OR matched OR business_capture_authorized);
-- Original operational contexts are typed, body-free immutable snapshots.
CREATE FUNCTION crm_mail_context_snapshot_valid(snapshot jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN jsonb_typeof(snapshot)<>'array' THEN false ELSE
 jsonb_array_length(snapshot)<=100 AND NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(snapshot) item WHERE CASE WHEN jsonb_typeof(item)<>'object' THEN true ELSE
   (SELECT count(*) FROM jsonb_object_keys(item))<>6 OR
   NOT (item ?& ARRAY['matchId','firmId','opportunityId','contactId','ambiguous','snapshotHash']) OR
   jsonb_typeof(item->'matchId')<>'string' OR (item->>'matchId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
   jsonb_typeof(item->'firmId')<>'string' OR (item->>'firmId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
   jsonb_typeof(item->'opportunityId')<>'string' OR (item->>'opportunityId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR
   (item->'contactId'<>'null'::jsonb AND (jsonb_typeof(item->'contactId')<>'string' OR (item->>'contactId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) OR
   jsonb_typeof(item->'ambiguous')<>'boolean' OR
   jsonb_typeof(item->'snapshotHash')<>'string' OR (item->>'snapshotHash') !~ '^[a-f0-9]{64}$' END
 ) END
$$;
CREATE TABLE crm_mail_capture_identities (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL, account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),
 provider_message_id text NOT NULL CHECK(provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 context_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT crm_mail_capture_context_snapshot_body_free CHECK(crm_mail_context_snapshot_valid(context_snapshot)),
 source_id uuid, lease_fencing_token bigint NOT NULL CHECK(lease_fencing_token>0), job_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','copied','blocked')),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,mailbox_id,account_binding,provider_message_id),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id)
);
CREATE TABLE crm_mail_sources (
 workspace_id uuid NOT NULL, source_id uuid NOT NULL, capture_identity_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 owner_user_id uuid NOT NULL, mailbox_id uuid NOT NULL, provider_account_id text NOT NULL CHECK(length(provider_account_id) BETWEEN 1 AND 320),
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'), acquired_generation integer NOT NULL CHECK(acquired_generation>0),
 controls_revision integer NOT NULL CHECK(controls_revision>0), policy_revision integer NOT NULL CHECK(policy_revision>0),
 conversation_id uuid NOT NULL, decision_revision integer NOT NULL CHECK(decision_revision>=0),
 disclosure_version text NOT NULL CHECK(length(disclosure_version) BETWEEN 1 AND 100), disclosure_sha256 text NOT NULL CHECK(disclosure_sha256 ~ '^[a-f0-9]{64}$'),
 verification_receipts jsonb NOT NULL CHECK(jsonb_typeof(verification_receipts)='object' AND length(verification_receipts::text)<=2000),
 parser_version text NOT NULL CHECK(length(parser_version) BETWEEN 1 AND 100),
 representation text NOT NULL CHECK(representation IN ('plain_text','html_flattened')),
 completeness text NOT NULL CHECK(completeness IN ('complete','partial','unavailable')),
 passage_ranges jsonb NOT NULL CHECK(jsonb_typeof(passage_ranges)='array' AND jsonb_array_length(passage_ranges)<=100 AND length(passage_ranges::text)<=20000),
 participants jsonb NOT NULL CHECK(jsonb_typeof(participants)='array' AND jsonb_array_length(participants)<=50 AND length(participants::text)<=17000),
 raw_sender_date text CHECK(length(raw_sender_date)<=200), provider_at timestamptz,
 observed_at timestamptz DEFAULT now(), sent_proof boolean NOT NULL DEFAULT false,
 availability text NOT NULL DEFAULT 'available' CHECK(availability IN ('available','deleted','awaiting_recapture')),
 CONSTRAINT crm_mail_available_source_dates CHECK(availability<>'available' OR (provider_at IS NOT NULL AND observed_at IS NOT NULL)),
 PRIMARY KEY(workspace_id,source_id),
 FOREIGN KEY(workspace_id,capture_identity_id) REFERENCES crm_mail_capture_identities(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES crm_business_conversations(workspace_id,id)
);
CREATE TABLE crm_mail_source_contexts (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), source_id uuid NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 person_id uuid, firm_id uuid, opportunity_id uuid,
 correspondent_endpoint_hash text CHECK(correspondent_endpoint_hash ~ '^[a-f0-9]{64}$'),
 observed_full_name_hash text CONSTRAINT crm_mail_observed_name_hash_format CHECK(observed_full_name_hash ~ '^[a-f0-9]{64}$'),
 CONSTRAINT crm_mail_observed_label_hash_required CHECK((identity_status='observed_label')=(observed_full_name_hash IS NOT NULL)),
 identity_status text NOT NULL DEFAULT 'unresolved' CHECK(identity_status IN ('unresolved','observed_label','reviewed')),
 CHECK(correspondent_endpoint_hash IS NULL OR (person_id IS NOT NULL AND identity_status='observed_label' AND context_kind='acquired')),
 operational_match_id uuid, operational_match_hash text CHECK(operational_match_hash ~ '^[a-f0-9]{64}$'),
 CHECK((operational_match_id IS NULL)=(operational_match_hash IS NULL)),
 context_kind text NOT NULL CHECK(context_kind IN ('acquired','reviewed')),
 review text NOT NULL DEFAULT 'current' CHECK(review IN ('current','review_required')),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES crm_mail_sources(workspace_id,source_id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,person_id) REFERENCES crm_people(workspace_id,id),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id),
 FOREIGN KEY(workspace_id,opportunity_id) REFERENCES opportunities(workspace_id,id),
 CHECK(person_id IS NOT NULL OR firm_id IS NOT NULL), CHECK(opportunity_id IS NULL OR firm_id IS NOT NULL)
);
CREATE INDEX crm_mail_contexts_person_page ON crm_mail_source_contexts(workspace_id,person_id,source_id);
CREATE TABLE crm_mail_acquisition_tombstones (
 workspace_id uuid NOT NULL, capture_identity_id uuid NOT NULL, source_id uuid NOT NULL, owner_user_id uuid NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 availability text NOT NULL CHECK(availability IN ('deleted','awaiting_recapture')),
 PRIMARY KEY(workspace_id,source_id,source_revision), UNIQUE(workspace_id,capture_identity_id,source_revision),
 FOREIGN KEY(workspace_id,capture_identity_id) REFERENCES crm_mail_capture_identities(workspace_id,id)
);
CREATE TABLE crm_mail_source_intents (
 workspace_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 source_kind text NOT NULL CHECK(source_kind='mail'), source_id uuid NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','invalidated')),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,source_kind,source_id,source_revision,content_hash)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_capture_identities,crm_mail_sources,crm_mail_source_contexts,crm_mail_acquisition_tombstones,crm_mail_source_intents TO app_runtime,migration;

-- A deleted body-free head can outlive its canonical message. Available copies
-- always have a canonical message, including after same-ID explicit recapture.
CREATE FUNCTION crm_mail_available_source_canonical_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid; target_source uuid;
BEGIN
 IF TG_TABLE_NAME='mail_messages' THEN target_workspace:=OLD.workspace_id; target_source:=OLD.id;
 ELSE target_workspace:=NEW.workspace_id; target_source:=NEW.source_id; END IF;
 IF EXISTS(SELECT 1 FROM crm_mail_sources s WHERE s.workspace_id=target_workspace AND s.source_id=target_source AND s.availability='available')
 THEN
  PERFORM 1 FROM mail_messages m WHERE m.workspace_id=target_workspace AND m.id=target_source FOR KEY SHARE;
  IF NOT FOUND THEN
  RAISE foreign_key_violation USING CONSTRAINT='crm_mail_available_source_canonical', MESSAGE='Available CRM mail source requires its canonical message';
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_mail_source_canonical_gate AFTER INSERT OR UPDATE ON crm_mail_sources
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_mail_available_source_canonical_guard();
CREATE CONSTRAINT TRIGGER crm_mail_message_canonical_gate AFTER DELETE ON mail_messages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_mail_available_source_canonical_guard();
