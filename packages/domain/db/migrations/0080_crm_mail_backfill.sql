-- #484 final schema80: integrated after evidence decisions schema79.
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
 history_page_token text CHECK(length(history_page_token) BETWEEN 1 AND 2000),
 history_complete boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','partial','complete','blocked')),
 reason text CHECK(reason ~ '^[a-z][a-z0-9_]{0,99}$'),
 last_scheduled_scan_at timestamptz, completed_at timestamptz, observed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,mailbox_id,account_binding,generation,controls_revision,policy_revision),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 CHECK(from_at<to_at AND to_at-from_at=interval '90 days'),
 CHECK((history_anchor IS NULL)=(history_cursor IS NULL)),
 CHECK(NOT history_complete OR (history_anchor IS NOT NULL AND history_page_token IS NULL)),
 CHECK(history_page_token IS NULL OR history_cursor IS NOT NULL),
 CHECK((state='complete')=(completed_at IS NOT NULL)),
 CHECK(state<>'complete' OR history_complete)
);
CREATE INDEX crm_mail_import_pending_scan ON crm_mail_imports(last_scheduled_scan_at,workspace_id,id) WHERE state<>'complete';
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
-- Schema80 operator configuration only, no enabling public command.
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
GRANT SELECT,INSERT ON crm_mail_import_read_reservations TO app_runtime,migration;
GRANT UPDATE(state,observed_at) ON crm_mail_import_read_reservations TO app_runtime,migration;
CREATE FUNCTION enforce_crm_mail_import_read_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'unknown' OR NEW.state<>'observed' OR OLD.observed_at IS NOT NULL OR NEW.observed_at IS NULL
 OR ROW(NEW.workspace_id,NEW.id,NEW.import_id,NEW.project_hash,NEW.user_hash,NEW.allocation_revision,NEW.method,NEW.units,NEW.reserved_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.import_id,OLD.project_hash,OLD.user_hash,OLD.allocation_revision,OLD.method,OLD.units,OLD.reserved_at)
 THEN RAISE EXCEPTION 'Conserved read reservations permit only their first observation marker' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER crm_mail_import_read_conserved BEFORE UPDATE ON crm_mail_import_read_reservations
 FOR EACH ROW EXECUTE FUNCTION enforce_crm_mail_import_read_conservation();

-- Sensitive causal metadata is versioned and terminally redacted; quota accounting is independent.
CREATE TABLE crm_mail_import_messages (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),import_id uuid NOT NULL,
 message_hash text NOT NULL CHECK(message_hash ~ '^[a-f0-9]{64}$'),
 provider_message_id text CHECK(provider_message_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 provider_thread_id text CHECK(provider_thread_id ~ '^[A-Za-z0-9_-]{1,128}$'),provider_at timestamptz,
 scope text NOT NULL CHECK(scope IN ('historical','overlap','reconciliation')),
 state text NOT NULL CHECK(state IN ('available','refused','confirmed_missing','deleted')),
 reason text CHECK(reason IN ('outside_review_window','metadata_observation_unavailable','provider_confirmed_missing','metadata_deleted')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,import_id,message_hash),
 FOREIGN KEY(workspace_id,import_id) REFERENCES crm_mail_imports(workspace_id,id) ON DELETE CASCADE,
 CHECK((state='available' AND provider_message_id IS NOT NULL AND provider_thread_id IS NOT NULL AND provider_at IS NOT NULL AND reason IS NULL)
   OR (state='refused' AND provider_message_id IS NOT NULL AND provider_thread_id IS NULL AND provider_at IS NULL AND reason IN ('outside_review_window','metadata_observation_unavailable'))
   OR (state='confirmed_missing' AND provider_message_id IS NOT NULL AND provider_thread_id IS NULL AND provider_at IS NULL AND reason='provider_confirmed_missing')
   OR (state='deleted' AND provider_message_id IS NULL AND provider_thread_id IS NULL AND provider_at IS NULL AND reason='metadata_deleted'))
);
GRANT SELECT,INSERT,UPDATE,DELETE ON crm_mail_import_messages TO app_runtime,migration;

CREATE INDEX crm_mail_import_active_jobs ON jobs(workspace_id,(payload->>'importId')) WHERE kind='crm.mail_backfill' AND state IN ('queued','retryable','running');

-- Dated provider-original observations are independent of the retained Callie copy.
ALTER TABLE crm_mail_sources
 ADD COLUMN original_availability text NOT NULL DEFAULT 'unknown' CHECK(original_availability IN ('unknown','available','trashed','confirmed_missing','transient_unavailable')),
 ADD COLUMN original_observation_revision bigint NOT NULL DEFAULT 0 CHECK(original_observation_revision>=0),
 ADD COLUMN original_observed_at timestamptz,
 ADD COLUMN original_observed_generation integer CHECK(original_observed_generation>0),
 ADD COLUMN original_observed_account_binding text CHECK(original_observed_account_binding ~ '^[a-f0-9]{64}$'),
 ADD COLUMN original_observation_reason text CHECK(original_observation_reason IN ('verified_metadata','verified_trash_label','verified_message_not_found','grant_unavailable','rate_limited','provider_unavailable')),
 ADD CONSTRAINT crm_mail_original_observation_shape CHECK(
  (original_availability='unknown' AND original_observed_at IS NULL AND original_observed_generation IS NULL AND original_observed_account_binding IS NULL AND original_observation_reason IS NULL)
  OR (original_observation_revision>0 AND original_observed_at IS NOT NULL AND original_observed_generation IS NOT NULL AND original_observed_account_binding IS NOT NULL
   AND ((original_availability='available' AND original_observation_reason='verified_metadata') OR (original_availability='trashed' AND original_observation_reason='verified_trash_label') OR (original_availability='confirmed_missing' AND original_observation_reason='verified_message_not_found') OR (original_availability='transient_unavailable' AND original_observation_reason IN ('grant_unavailable','rate_limited','provider_unavailable'))))),
 ADD CONSTRAINT crm_mail_deleted_original_observation CHECK(availability<>'deleted' OR original_availability='unknown');

CREATE TABLE crm_mail_history_recoveries (
 workspace_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),import_id uuid NOT NULL,
 epoch integer NOT NULL CHECK(epoch BETWEEN 1 AND 4),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 account_binding text NOT NULL CHECK(account_binding ~ '^[a-f0-9]{64}$'),generation integer NOT NULL CHECK(generation>0),
 controls_revision integer NOT NULL CHECK(controls_revision>0),policy_revision integer NOT NULL CHECK(policy_revision>0),
 allocation_revision integer NOT NULL CHECK(allocation_revision>0),configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
 from_at timestamptz,to_at timestamptz,history_anchor text CHECK(history_anchor ~ '^[0-9]{1,20}$'),history_cursor text CHECK(history_cursor ~ '^[0-9]{1,20}$'),history_page_token text CHECK(length(history_page_token) BETWEEN 1 AND 2000),
 total_days integer CHECK(total_days BETWEEN 1 AND 90),next_day_ordinal integer NOT NULL DEFAULT 0 CHECK(next_day_ordinal BETWEEN 0 AND 90),next_day_page_token text CHECK(length(next_day_page_token) BETWEEN 1 AND 2000),
 state text NOT NULL DEFAULT 'pending_profile' CHECK(state IN ('pending_profile','enumerating','draining','complete','blocked','deleted')),
 reason text CHECK(reason IN ('history_coverage_expired','coverage_gap_too_old','configuration_changed','acquisition_binding_changed','retention_expired','metadata_deleted')),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,import_id,epoch),FOREIGN KEY(workspace_id,import_id) REFERENCES crm_mail_imports(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT crm_mail_recovery_scope_shape CHECK(
 (state='deleted' AND from_at IS NULL AND to_at IS NULL AND history_anchor IS NULL AND history_cursor IS NULL AND history_page_token IS NULL AND total_days IS NULL AND next_day_ordinal=0 AND next_day_page_token IS NULL AND completed_at IS NULL AND reason IN ('retention_expired','metadata_deleted'))
 OR (from_at IS NOT NULL AND to_at IS NULL AND history_anchor IS NULL AND history_cursor IS NULL AND history_page_token IS NULL AND total_days IS NULL AND next_day_ordinal=0 AND next_day_page_token IS NULL AND completed_at IS NULL AND state IN ('pending_profile','blocked'))
 OR (from_at IS NOT NULL AND to_at IS NOT NULL AND total_days IS NOT NULL AND to_at>from_at AND to_at-from_at<=interval '7776000 seconds' AND history_anchor IS NOT NULL AND history_cursor IS NOT NULL AND history_cursor::numeric>=history_anchor::numeric AND total_days=ceil(extract(epoch FROM(to_at-from_at))/86400)::integer AND next_day_ordinal<=total_days AND state IN ('enumerating','draining','complete','blocked') AND (state<>'draining' OR next_day_ordinal=total_days) AND (state<>'complete' OR (next_day_ordinal=total_days AND history_page_token IS NULL AND next_day_page_token IS NULL AND completed_at IS NOT NULL)))
 OR (state='blocked' AND reason='coverage_gap_too_old' AND from_at IS NOT NULL AND to_at-from_at>interval '7776000 seconds' AND history_anchor IS NOT NULL AND history_cursor=history_anchor AND total_days IS NULL AND next_day_ordinal=0 AND history_page_token IS NULL AND next_day_page_token IS NULL AND completed_at IS NULL))
);
CREATE INDEX crm_mail_history_recovery_unfinished ON crm_mail_history_recoveries(workspace_id,import_id,epoch DESC) WHERE state IN ('pending_profile','enumerating','draining');
GRANT SELECT,INSERT,UPDATE ON crm_mail_history_recoveries TO app_runtime,migration;
ALTER TABLE crm_mail_history_recoveries ADD CONSTRAINT crm_mail_recovery_completion_shape CHECK((state='complete')=(completed_at IS NOT NULL)), ADD CONSTRAINT crm_mail_recovery_reason_shape CHECK((state IN ('blocked','deleted'))=(reason IS NOT NULL));

ALTER TABLE crm_mail_history_recoveries ADD COLUMN reconciliation_after_source_id uuid,
 ADD COLUMN reconciliation_visited numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_refreshed numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_unresolved numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_exhausted boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT crm_mail_recovery_reconciliation_counts CHECK(reconciliation_visited>=0 AND reconciliation_refreshed>=0 AND reconciliation_unresolved>=0 AND reconciliation_refreshed+reconciliation_unresolved<=reconciliation_visited),
 ADD CONSTRAINT crm_mail_recovery_reconciliation_phase CHECK((state NOT IN ('pending_profile','deleted') OR (reconciliation_after_source_id IS NULL AND reconciliation_visited=0 AND reconciliation_refreshed=0 AND reconciliation_unresolved=0 AND NOT reconciliation_exhausted)) AND (state<>'complete' OR reconciliation_exhausted));

CREATE FUNCTION enforce_crm_mail_recovery_progress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.id,NEW.import_id,NEW.epoch,NEW.account_binding,NEW.generation,NEW.controls_revision,NEW.policy_revision,NEW.allocation_revision,NEW.configuration_hash)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.import_id,OLD.epoch,OLD.account_binding,OLD.generation,OLD.controls_revision,OLD.policy_revision,OLD.allocation_revision,OLD.configuration_hash)
 OR OLD.state='deleted' OR NEW.revision<>OLD.revision+1 OR NEW.observed_at<OLD.observed_at
 THEN RAISE EXCEPTION 'Recovery bindings and epochs are immutable' USING ERRCODE='23514',CONSTRAINT='crm_mail_recovery_immutable'; END IF;
 IF NEW.state='deleted' THEN RETURN NEW; END IF;
 IF (OLD.state='pending_profile' AND NEW.state NOT IN ('pending_profile','enumerating','blocked'))
 OR (OLD.state='enumerating' AND NEW.state NOT IN ('enumerating','draining','blocked'))
 OR (OLD.to_at IS NULL AND NEW.to_at IS NOT NULL AND (NEW.next_day_ordinal<>0 OR NEW.history_cursor IS DISTINCT FROM NEW.history_anchor OR NEW.history_page_token IS NOT NULL OR NEW.next_day_page_token IS NOT NULL OR NEW.reconciliation_after_source_id IS NOT NULL OR NEW.reconciliation_visited<>0 OR NEW.reconciliation_refreshed<>0 OR NEW.reconciliation_unresolved<>0 OR NEW.reconciliation_exhausted))
 OR NEW.reconciliation_visited<OLD.reconciliation_visited OR NEW.reconciliation_visited>OLD.reconciliation_visited+1
 OR NEW.reconciliation_refreshed<OLD.reconciliation_refreshed OR NEW.reconciliation_unresolved<OLD.reconciliation_unresolved
 OR (OLD.reconciliation_exhausted AND NOT NEW.reconciliation_exhausted)
 OR NEW.from_at IS DISTINCT FROM OLD.from_at OR (OLD.to_at IS NOT NULL AND ROW(NEW.to_at,NEW.history_anchor,NEW.total_days) IS DISTINCT FROM ROW(OLD.to_at,OLD.history_anchor,OLD.total_days))
 OR NEW.next_day_ordinal<OLD.next_day_ordinal OR NEW.next_day_ordinal>OLD.next_day_ordinal+1
 OR (OLD.history_cursor IS NOT NULL AND NEW.history_cursor::numeric<OLD.history_cursor::numeric)
 OR (OLD.state='complete' AND NEW.state<>'complete') OR (OLD.state='blocked' AND NEW.state<>'blocked')
 OR (OLD.state='draining' AND NEW.state NOT IN ('draining','complete','blocked'))
 THEN RAISE EXCEPTION 'Recovery scope and progress cannot be reset' USING ERRCODE='23514',CONSTRAINT='crm_mail_recovery_monotonic'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_mail_recovery_progress BEFORE UPDATE ON crm_mail_history_recoveries FOR EACH ROW EXECUTE FUNCTION enforce_crm_mail_recovery_progress();

-- Current-copy traversal is deliberately not a frozen membership/completeness claim.
ALTER TABLE crm_mail_imports ADD COLUMN reconciliation_after_source_id uuid,
 ADD COLUMN reconciliation_visited numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_refreshed numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_unresolved numeric(40,0) NOT NULL DEFAULT 0,
 ADD COLUMN reconciliation_exhausted boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT crm_mail_reconciliation_counts CHECK(reconciliation_visited>=0 AND reconciliation_refreshed>=0 AND reconciliation_unresolved>=0 AND reconciliation_refreshed+reconciliation_unresolved<=reconciliation_visited);
