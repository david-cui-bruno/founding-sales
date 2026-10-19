-- changes: national_registry_snapshots, national_registry_endpoint_scrubs, phone_handoff_attempts, call_logs
-- Empty tables confer no registry clearance. No provider setting or prospect is changed.
-- Registry publication/revocation MUST take the same workspace admission stop-gate
-- exclusively. Admission takes that gate exclusively, selects the latest PUBLISHED
-- covering snapshot (even if unusable), locks it, then reads clock_timestamp().
-- Never fall back to an older clear publication. Drafts have published_at NULL.
-- A linked outcome follows both contact and opportunity during an explicit firm merge.
-- Both semantic keys must agree again before the merge's final immediate check.
ALTER TABLE call_logs ALTER CONSTRAINT call_logs_opportunity_fkey DEFERRABLE INITIALLY IMMEDIATE;
CREATE TABLE national_registry_snapshots (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  receipt_reference text NOT NULL CHECK (length(btrim(receipt_reference)) BETWEEN 1 AND 500),
  downloaded_at timestamptz NOT NULL,
  published_at timestamptz,
  complete boolean NOT NULL DEFAULT false,
  covered_area_codes text[] NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  CHECK (cardinality(covered_area_codes) BETWEEN 1 AND 5),
  CHECK (array_to_string(covered_area_codes,',') ~ '^[2-9][0-9]{2}(,[2-9][0-9]{2}){0,4}$'),
  CHECK (array_position(covered_area_codes,NULL) IS NULL),
  CHECK (published_at IS NULL OR published_at >= downloaded_at),
  CHECK (revoked_at IS NULL OR revoked_at >= downloaded_at)
);
CREATE INDEX national_registry_snapshots_publication
  ON national_registry_snapshots(workspace_id,published_at DESC,id DESC) WHERE published_at IS NOT NULL;

CREATE TABLE national_registry_endpoint_scrubs (
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  e164 text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  scrubbed_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN ('clear','match')),
  PRIMARY KEY (workspace_id,snapshot_id,e164),
  FOREIGN KEY (workspace_id,snapshot_id) REFERENCES national_registry_snapshots(workspace_id,id)
);
-- Endpoint scrubs are erased by exact handle during journalled prospect deletion.
-- Losing clearance for a shared number is intentionally conservative.

CREATE TABLE phone_handoff_attempts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  command_id text NOT NULL CHECK (length(btrim(command_id)) BETWEEN 1 AND 200),
  contact_id uuid,
  opportunity_id uuid,
  phone_route_id uuid,
  route_version integer CHECK (route_version >= 1),
  e164 text CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  item_id uuid,
  registry_snapshot_id uuid,
  registry_scrubbed_at timestamptz,
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  call_log_id uuid,
  erased_at timestamptz,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,command_id),
  UNIQUE (workspace_id,call_log_id),
  FOREIGN KEY (workspace_id,firm_id) REFERENCES firms(workspace_id,id),
  FOREIGN KEY (workspace_id,actor_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
  FOREIGN KEY (workspace_id,device_id) REFERENCES devices(workspace_id,id),
  FOREIGN KEY (workspace_id,contact_id,firm_id) REFERENCES contacts(workspace_id,id,firm_id) ON UPDATE CASCADE,
  CONSTRAINT phone_handoff_attempts_opportunity_fkey FOREIGN KEY (workspace_id,opportunity_id,firm_id) REFERENCES opportunities(workspace_id,id,firm_id) ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id,phone_route_id) REFERENCES phone_routes(workspace_id,id),
  FOREIGN KEY (workspace_id,registry_snapshot_id) REFERENCES national_registry_snapshots(workspace_id,id),
  FOREIGN KEY (workspace_id,call_log_id) REFERENCES call_logs(workspace_id,id),
  CHECK (expires_at > reserved_at AND expires_at <= reserved_at + interval '15 seconds'),
  CHECK (erased_at IS NULL OR erased_at >= reserved_at),
  CHECK (
    (erased_at IS NULL AND e164 IS NOT NULL AND phone_route_id IS NOT NULL
      AND route_version IS NOT NULL AND registry_snapshot_id IS NOT NULL AND registry_scrubbed_at IS NOT NULL)
    OR
    (erased_at IS NOT NULL AND e164 IS NULL AND phone_route_id IS NULL AND route_version IS NULL
      AND contact_id IS NULL AND opportunity_id IS NULL AND item_id IS NULL
      AND registry_snapshot_id IS NULL AND registry_scrubbed_at IS NULL AND call_log_id IS NULL)
  )
);
CREATE INDEX phone_handoff_attempts_cadence ON phone_handoff_attempts(workspace_id,firm_id,reserved_at,id);
-- Every reservation, including an erased opaque tombstone, counts. Expiry is only
-- dispatch validity, never an attempt refund. No OS success or recording is inferred.
-- The atomic command receipt stores ONLY attemptId, never number/URI/prospect data.
-- Journalled erasure clears nullable bindings before deleting routes/logs/scrubs.
GRANT SELECT,INSERT,UPDATE ON phone_handoff_attempts TO app_runtime,migration;
GRANT SELECT,INSERT,UPDATE ON national_registry_snapshots TO app_runtime,migration;
GRANT SELECT,INSERT,DELETE ON national_registry_endpoint_scrubs TO app_runtime,migration;
