-- ---------------------------------------------------------------------------
-- 0016_calling_identity_attestation.sql — who verified a calling number, how, and
-- when it stopped being used (lane g60)
--
-- Migration 0001 made `calling_identities` and `authorizeDial` reads it at 9.2's
-- second step, but nothing in the tree ever inserted a row or set one to
-- `verified`. So production's only salesperson could not place a call from Today,
-- and the restore drill's dial probe had no subject. Lane g60 adds the product path:
-- a salesperson registers their own number and attests that it is the one they
-- place calls from (`docs/decisions/g60-calling-identities-are-attested-in-version-one.md`).
--
-- What an attestation is worth is exactly what the row records about it, so this
-- migration gives the row somewhere to record it:
--
--   * `label` — the person's own name for the number ("Mobile"). Display only.
--   * `verified_at`, `verified_by_user_id`, `verification_method` — the instant,
--     the member who attested, and which kind of attestation it was. Version one
--     has two methods, both of them a person's statement: the owner's own
--     (`owner_attestation`) and an admin's on a member's behalf
--     (`admin_attestation`). A later call-back code would be a third value.
--   * `disabled_at`, `disabled_by_user_id` — the retirement. A retired identity is
--     never deleted: `call_logs` and `dial_tickets` reference it, and 9.1's "call
--     logging never refuses history" is also a statement about what those rows
--     point at.
--
-- ## Expand only
--
-- Every column is nullable with no default, so every binary that ran against 15
-- still reads and writes this table. Two of the new constraints could not hold for
-- a row written before them, and one is therefore `NOT VALID`:
--
--   * `calling_identities_verification_recorded` — a `verified` row names who
--     verified it, how and when. No code path before this migration wrote a
--     verified row, so on every database this has met there is nothing it would
--     refuse; it is still `NOT VALID`, as `docs/greenfield/migrations.md` asks of a
--     constraint whose data is not *known* to satisfy it, because a verified row
--     inserted by hand would otherwise stop this migration in production. It is
--     enforced for every insert and update from here on, which is the part that
--     matters: there is no second way to become verified.
--   * `calling_identities_disable_recorded` — a retirement names who and when, and
--     a retired row is not enabled. Every existing row has both columns null, so
--     this one is validated.
--
-- The two new foreign keys point the recorded people at `workspace_memberships`,
-- exactly as `owner_user_id` already does, so an attestation cannot name somebody
-- outside the workspace. On existing rows both columns are null and `MATCH SIMPLE`
-- skips them.
--
-- ## The schema range
--
-- The API's new routes write these columns, so `API_SCHEMA_RANGE` becomes {16, 16};
-- the worker moves with it for the reason G20 gave for 0015 (a worker declaring 15
-- would admit half a deployment the release procedure forbids). See
-- `packages/domain/db/schemaRange.ts`.
--
-- ## Privileges
--
-- None. 0001's `GRANT … ON ALL TABLES` covered `calling_identities` when it was
-- created, and a column added later is covered by the table's grant.
-- ---------------------------------------------------------------------------

ALTER TABLE calling_identities
  ADD COLUMN label text,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by_user_id uuid,
  ADD COLUMN verification_method text,
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_by_user_id uuid;

ALTER TABLE calling_identities
  ADD CONSTRAINT calling_identities_label_shape
    CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80),
  ADD CONSTRAINT calling_identities_verification_method_known
    CHECK (verification_method IS NULL OR verification_method IN ('owner_attestation', 'admin_attestation')),
  ADD CONSTRAINT calling_identities_verified_by_fkey FOREIGN KEY (workspace_id, verified_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  ADD CONSTRAINT calling_identities_disabled_by_fkey FOREIGN KEY (workspace_id, disabled_by_user_id)
    REFERENCES workspace_memberships (workspace_id, user_id),
  ADD CONSTRAINT calling_identities_disable_recorded
    CHECK (
      (disabled_at IS NULL AND disabled_by_user_id IS NULL)
      OR (disabled_at IS NOT NULL AND disabled_by_user_id IS NOT NULL AND enabled = false)
    );

ALTER TABLE calling_identities
  ADD CONSTRAINT calling_identities_verification_recorded
    CHECK (
      verification_status <> 'verified'
      OR (verified_at IS NOT NULL AND verified_by_user_id IS NOT NULL AND verification_method IS NOT NULL)
    ) NOT VALID;
