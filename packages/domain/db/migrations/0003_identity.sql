-- 0003_identity
--
-- Sessions, device refresh credentials and one-time OpenID Connect authorization
-- requests (specification revision 3, sections 5.1 and 5.3, and Appendix G 23, 24
-- and 40). Additive only: migration 0001 is never edited, and every table here is
-- new except for one unique constraint added to `command_receipts`, explained in
-- docs/decisions/g2-command-id-uniqueness.md.
--
-- Three rules run through the file:
--
--   * Nothing secret is stored. Every credential column holds a sha256 digest, and
--     the CHECK on each one refuses anything that is not 64 lowercase hex characters,
--     so a plaintext token written there by mistake is refused by the database.
--   * Every lookup a caller can perform begins with `workspace_id`. The one
--     deliberate exception is `oidc_authorization_requests`, which is looked up
--     before there is an authenticated caller at all; see the comment on that table.
--   * State machines are enforced by CHECK constraints rather than by convention, so
--     a session that is "ended" without an end reason, or a refresh credential that
--     is "rotated" without having been used, cannot exist.

-- ---------------------------------------------------------------------------
-- sessions (specification 5.3)
--
-- "Sessions last about one hour and renew using a device-bound credential that
-- rotates on every use... Full Google sign-in recurs every 30 days or after
-- revocation." `expires_at` is the one-hour access expiry; `reauthenticate_after`
-- is the 30-day boundary, carried forward unchanged through every renewal, so the
-- renewal chain cannot extend itself indefinitely.
--
-- `access_token_hash` is unique inside the workspace rather than globally because
-- the bearer token the client presents names its workspace: the lookup is scoped by
-- construction. See docs/decisions/g2-session-token-shape.md.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  access_token_hash text NOT NULL,
  client_version text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  reauthenticate_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  ended_at timestamptz,
  end_reason text,
  CONSTRAINT sessions_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT sessions_token_unique UNIQUE (workspace_id, access_token_hash),
  CONSTRAINT sessions_device_fkey FOREIGN KEY (workspace_id, device_id)
    REFERENCES devices (workspace_id, id),
  CONSTRAINT sessions_membership_fkey FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  CONSTRAINT sessions_token_hash_shape CHECK (access_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_client_version_shape
    CHECK (client_version IS NULL OR client_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT sessions_status_known CHECK (status IN ('active', 'ended')),
  CONSTRAINT sessions_end_consistent CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CONSTRAINT sessions_end_reason_consistent CHECK ((status = 'ended') = (end_reason IS NOT NULL)),
  CONSTRAINT sessions_end_reason_known
    CHECK (end_reason IS NULL OR end_reason IN (
      'signed_out',
      'renewed',
      'device_revoked',
      'membership_revoked',
      'credential_reuse',
      'reauthentication_required'
    )),
  CONSTRAINT sessions_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT sessions_reauthentication_not_before_expiry CHECK (reauthenticate_after >= expires_at)
);

-- Revocation asks "which sessions does this device still hold", on every device
-- revocation and every credential-reuse detection.
CREATE INDEX sessions_active_by_device ON sessions (workspace_id, device_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- device_refresh_credentials (specification 5.3)
--
-- "a device-bound credential that rotates on every use. Reuse revokes the device."
-- The generation only ever increases, matching `devices.credential_generation` from
-- migration 0001, and the partial unique index below is what makes "one live
-- credential per device" a fact about the database rather than about the code that
-- writes it: a rotation that forgot to spend the old row cannot commit.
-- ---------------------------------------------------------------------------
CREATE TABLE device_refresh_credentials (
  workspace_id uuid NOT NULL,
  device_id uuid NOT NULL,
  generation bigint NOT NULL,
  secret_hash text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT device_refresh_credentials_pkey PRIMARY KEY (workspace_id, device_id, generation),
  CONSTRAINT device_refresh_credentials_device_fkey FOREIGN KEY (workspace_id, device_id)
    REFERENCES devices (workspace_id, id),
  CONSTRAINT device_refresh_credentials_secret_hash_shape CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT device_refresh_credentials_generation_positive CHECK (generation >= 1),
  CONSTRAINT device_refresh_credentials_state_known CHECK (state IN ('active', 'rotated', 'revoked')),
  CONSTRAINT device_refresh_credentials_use_consistent CHECK ((state = 'rotated') = (used_at IS NOT NULL)),
  CONSTRAINT device_refresh_credentials_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX device_refresh_credentials_one_active
  ON device_refresh_credentials (workspace_id, device_id)
  WHERE state = 'active';

-- ---------------------------------------------------------------------------
-- oidc_authorization_requests (specification 5.1, Appendix G 23)
--
-- One row per started sign-in, holding the one-time `state` and `nonce` and the PKCE
-- challenge. Only digests are stored: a reader of this table learns nothing it could
-- present to Google or to this API.
--
-- This is the one table whose lookup key does not begin with `workspace_id`, and it
-- is deliberate. Google redirects an anonymous browser to the API's callback with
-- nothing but `state`, and the desktop app claims its grant with nothing but the
-- handoff secret it generated; at both moments there is no authenticated caller and
-- therefore no scope. Both keys are 256-bit digests of unguessable values, both are
-- single use, and the row carries the workspace that the rest of the flow is scoped
-- by. See docs/decisions/g2-oidc-request-lookup.md.
-- ---------------------------------------------------------------------------
CREATE TABLE oidc_authorization_requests (
  state_hash text NOT NULL,
  workspace_id uuid NOT NULL,
  nonce_hash text NOT NULL,
  handoff_hash text NOT NULL,
  code_challenge text NOT NULL,
  device_label text NOT NULL,
  client_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  user_id uuid,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  claimed_at timestamptz,
  CONSTRAINT oidc_authorization_requests_pkey PRIMARY KEY (state_hash),
  CONSTRAINT oidc_authorization_requests_handoff_unique UNIQUE (handoff_hash),
  CONSTRAINT oidc_authorization_requests_workspace_fkey FOREIGN KEY (workspace_id)
    REFERENCES workspaces (id),
  CONSTRAINT oidc_authorization_requests_user_fkey FOREIGN KEY (user_id)
    REFERENCES users (id),
  CONSTRAINT oidc_authorization_requests_state_hash_shape CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_authorization_requests_nonce_hash_shape CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oidc_authorization_requests_handoff_hash_shape CHECK (handoff_hash ~ '^[0-9a-f]{64}$'),
  -- base64url of a sha256 digest: PKCE S256 and nothing else. `plain` is not accepted.
  CONSTRAINT oidc_authorization_requests_code_challenge_shape CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT oidc_authorization_requests_label_present
    CHECK (btrim(device_label) <> '' AND length(device_label) <= 120),
  CONSTRAINT oidc_authorization_requests_client_version_shape
    CHECK (client_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT oidc_authorization_requests_status_known
    CHECK (status IN ('pending', 'authenticated', 'claimed', 'failed')),
  CONSTRAINT oidc_authorization_requests_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT oidc_authorization_requests_resolution_consistent
    CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT oidc_authorization_requests_user_present
    CHECK ((status IN ('authenticated', 'claimed')) = (user_id IS NOT NULL)),
  CONSTRAINT oidc_authorization_requests_failure_code_present
    CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT oidc_authorization_requests_claim_consistent
    CHECK ((status = 'claimed') = (claimed_at IS NOT NULL))
);

-- Retention sweeps expired requests; nothing else reads this table by time.
CREATE INDEX oidc_authorization_requests_expiry ON oidc_authorization_requests (expires_at);

-- ---------------------------------------------------------------------------
-- command_receipts: one command id per workspace (specification 5.3)
--
-- "Same ID and payload returns the original result; a different payload or device is
-- rejected." Migration 0001's primary key is `(workspace_id, device_id, command_id)`,
-- which lets a second device reuse a command id by starting a second receipt. This
-- constraint makes the rejection the database's, not the middleware's. It is additive
-- and accepted by the previous release, which never wrote two such rows.
-- ---------------------------------------------------------------------------
ALTER TABLE command_receipts
  ADD CONSTRAINT command_receipts_command_id_unique UNIQUE (workspace_id, command_id);

-- ---------------------------------------------------------------------------
-- Privileges
--
-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed
-- then, so each new table needs its own grant. None of these is append-only: a
-- session ends, a credential rotates, and an expired authorization request is swept.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON sessions, device_refresh_credentials, oidc_authorization_requests
  TO app_runtime, migration;
