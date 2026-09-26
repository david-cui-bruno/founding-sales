-- ---------------------------------------------------------------------------
-- 0017_release_records.sql — the rehearsal gate an admin's sending attestation
-- names, stored where the send path can compare it with what is running (lane g71)
--
-- Specification 16.2: "Production sending remains disabled until all mandatory
-- scenarios for the affected release class pass, the deployed commit/image digests
-- match the rehearsal artifacts, and an authenticated admin enables sending."
--
-- Until this migration the middle clause was an instruction to a person. The admin's
-- attestation (`workspace_settings.sending_enabled`) carried a `releaseGateReference`
-- that could be any nonempty string, and nothing compared it with the images actually
-- deployed. `infra/scripts/rehearsal-release-record.sh` already wrote a durable record
-- of a green rehearsal — `fss.release-record.v1`, naming the API and worker digests —
-- and nothing read it.
--
-- This table is where that record goes (`fss admin release-record put`, run by
-- `deploy.sh release --release-record`), and two rules read it:
--
--   * the API refuses `sending_enabled = { enabled: true, releaseGateReference: R }`
--     unless R is a row here whose suite is `pass` and whose `api_digest` is the
--     digest of the API image that is serving the request;
--   * the worker refuses to dispatch unless the attested R is a row here whose suite
--     is `pass` and whose `worker_digest` is the digest of the worker image that is
--     about to send.
--
-- See `docs/decisions/g71-sending-gate-is-bound-to-the-release-record.md`.
--
-- ## Shape
--
-- One row per reference, never workspace-scoped: a release record is a fact about a
-- deployment's artifacts, and every workspace on that deployment is running the same
-- images. The whole record is kept in `record`, exactly as the rehearsal wrote it
-- (after the contract parsed it), and the five columns the rules and an operator read
-- are denormalised beside it. `release_records_record_matches_columns` is what keeps
-- the two from disagreeing: a row whose columns say one digest and whose record says
-- another is refused, so there is no second answer to "which images did this
-- rehearsal certify".
--
-- The digest CHECKs mirror the script's own refusals: `sha256:` and 64 lower-case hex
-- characters, and the API and worker digests different from each other (one image
-- pushed under both names).
--
-- ## Append-only
--
-- A release record is evidence, and evidence that can be edited is not evidence. The
-- runtime and migration roles may SELECT and INSERT and nothing else, so an attestation
-- can never come to name a record that changed after the admin relied on it. A second
-- put of the same reference is idempotent in the domain (same content: `existing`;
-- different content: `release_record_conflict`), never an UPDATE.
--
-- ## Expand only, and the schema range
--
-- A new table and nothing else, so every binary that ran against 16 still reads and
-- writes everything it did. Both services now read this table — the API in the
-- settings command, the worker in the send gate — so both ranges become {17, 17}.
-- See `packages/domain/db/schemaRange.ts`.
-- ---------------------------------------------------------------------------

CREATE TABLE release_records (
  reference            text        NOT NULL,
  recorded_at          timestamptz NOT NULL,
  suite                text        NOT NULL,
  api_digest           text        NOT NULL,
  worker_digest        text        NOT NULL,
  desktop_commit_stamp text        NOT NULL,
  enables_sending      boolean     NOT NULL,
  record               jsonb       NOT NULL,
  put_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT release_records_pkey PRIMARY KEY (reference),
  CONSTRAINT release_records_reference_shape
    CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  CONSTRAINT release_records_suite_shape
    CHECK (suite ~ '^[a-z][a-z_]{0,39}$'),
  CONSTRAINT release_records_api_digest_shape
    CHECK (api_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT release_records_worker_digest_shape
    CHECK (worker_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT release_records_digests_differ
    CHECK (api_digest <> worker_digest),
  CONSTRAINT release_records_desktop_stamp_present
    CHECK (char_length(btrim(desktop_commit_stamp)) BETWEEN 1 AND 200),
  CONSTRAINT release_records_record_is_object
    CHECK (jsonb_typeof(record) = 'object'),
  -- `IS NOT DISTINCT FROM` rather than `=`: a record missing a key gives NULL, and a
  -- CHECK that evaluates to NULL passes. The comparison has to be false for it.
  CONSTRAINT release_records_record_matches_columns
    CHECK (
      record->>'schema' IS NOT DISTINCT FROM 'fss.release-record.v1'
      AND record->>'releaseGateReference' IS NOT DISTINCT FROM reference
      AND record->>'suite' IS NOT DISTINCT FROM suite
      AND record->'artifacts'->>'api' IS NOT DISTINCT FROM api_digest
      AND record->'artifacts'->>'worker' IS NOT DISTINCT FROM worker_digest
      AND record->'artifacts'->>'desktopCommitStamp' IS NOT DISTINCT FROM desktop_commit_stamp
      AND record->'enablesSending' IS NOT DISTINCT FROM to_jsonb(enables_sending)
    )
);

-- Migration 0001's `GRANT ... ON ALL TABLES` covered only the tables that existed then.
-- Append-only: read and insert, and the REVOKE says so out loud.
GRANT SELECT, INSERT ON release_records TO app_runtime, migration;
REVOKE UPDATE, DELETE, TRUNCATE ON release_records FROM app_runtime, migration;
