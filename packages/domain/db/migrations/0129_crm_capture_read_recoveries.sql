-- changes: crm_capture_read_recoveries, crm_capture_read_progress
-- Capture-read clearance only. Existing incidents, holds, sending and operational cursors stay unchanged.
CREATE TABLE crm_capture_read_recoveries (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 mailbox_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation>0),
 incident_id uuid NOT NULL,
 requester_user_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 owner_approval_id uuid NOT NULL,
 controls_revision integer NOT NULL CHECK(controls_revision>0),
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 recovery_binding_sha256 text NOT NULL CHECK(recovery_binding_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','probing','verified','refused','uncertain','stale')),
 coded_outcome text CHECK(coded_outcome IN ('capture_authority_unavailable','mailbox_binding_changed','incident_not_eligible','additional_incident','attempt_already_used','probe_in_progress','provider_refused','provider_uncertain','profile_identity_mismatch','recovery_binding_changed','capture_read_verified','capture_consumer_unavailable')),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 probe_started_at timestamptz,
 completed_at timestamptz,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,mailbox_id,generation,incident_id),
 UNIQUE(workspace_id,id,mailbox_id,generation),
 FOREIGN KEY(workspace_id,mailbox_id) REFERENCES mailboxes(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,incident_id) REFERENCES mailbox_provider_incidents(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,requester_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,owner_approval_id) REFERENCES crm_capability_owner_approvals(workspace_id,id),
 CONSTRAINT crm_capture_read_recovery_state_times CHECK(
  (state='queued' AND probe_started_at IS NULL AND completed_at IS NULL AND coded_outcome IS NULL)
  OR (state='probing' AND probe_started_at IS NOT NULL AND completed_at IS NULL AND coded_outcome IS NULL)
  OR (state IN ('verified','refused','uncertain','stale') AND completed_at IS NOT NULL AND coded_outcome IS NOT NULL AND (state<>'verified' OR (probe_started_at IS NOT NULL AND coded_outcome='capture_read_verified')))
 ),
 CHECK(probe_started_at IS NULL OR probe_started_at>=requested_at),
 CHECK(completed_at IS NULL OR completed_at>=coalesce(probe_started_at,requested_at))
);
CREATE INDEX crm_capture_read_recoveries_work ON crm_capture_read_recoveries(workspace_id,state,requested_at,id);
GRANT SELECT,INSERT ON crm_capture_read_recoveries TO app_runtime,migration;
GRANT UPDATE(state,coded_outcome,probe_started_at,completed_at) ON crm_capture_read_recoveries TO app_runtime,migration;
CREATE FUNCTION crm_capture_read_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','coded_outcome','probe_started_at','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','coded_outcome','probe_started_at','completed_at'])
 OR NOT ((OLD.state='queued' AND NEW.state IN ('probing','refused','stale') AND (NEW.state<>'probing' OR NEW.probe_started_at IS NOT NULL))
      OR (OLD.state='probing' AND NEW.state IN ('verified','refused','uncertain','stale') AND NEW.probe_started_at IS NOT DISTINCT FROM OLD.probe_started_at))
 THEN RAISE EXCEPTION 'Invalid capture read recovery transition'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER crm_capture_read_recovery_transition BEFORE UPDATE ON crm_capture_read_recoveries
 FOR EACH ROW EXECUTE FUNCTION crm_capture_read_recovery_transition();

-- Mutable CRM-only progress, not operational history, send reconciliation or import identity.
CREATE TABLE crm_capture_read_progress (
 workspace_id uuid NOT NULL,
 recovery_id uuid NOT NULL,
 mailbox_id uuid NOT NULL,
 generation integer NOT NULL CHECK(generation>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','scanning','current','blocked','uncertain')),
 forward_cutoff_at timestamptz NOT NULL,
 window_from_at timestamptz NOT NULL,
 window_to_at timestamptz,
 next_page_token text CHECK(length(next_page_token) BETWEEN 1 AND 4096),
 visited_messages bigint NOT NULL DEFAULT 0 CHECK(visited_messages>=0),
 observed_metadata bigint NOT NULL DEFAULT 0 CHECK(observed_metadata>=0 AND observed_metadata<=visited_messages),
 last_scan_at timestamptz,
 coded_reason text CHECK(coded_reason IN ('authority_changed','incident_changed','provider_refused','provider_uncertain','invalid_metadata','consumer_unavailable')),
 PRIMARY KEY(workspace_id,recovery_id),
 FOREIGN KEY(workspace_id,recovery_id,mailbox_id,generation)
  REFERENCES crm_capture_read_recoveries(workspace_id,id,mailbox_id,generation) ON DELETE CASCADE,
 CHECK(window_from_at>=forward_cutoff_at),
 CHECK(window_to_at IS NULL OR window_to_at>=window_from_at),
 CHECK(next_page_token IS NULL OR window_to_at IS NOT NULL)
);
GRANT SELECT,INSERT ON crm_capture_read_progress TO app_runtime,migration;
GRANT UPDATE(revision,state,window_from_at,window_to_at,next_page_token,visited_messages,observed_metadata,last_scan_at,coded_reason)
 ON crm_capture_read_progress TO app_runtime,migration;
