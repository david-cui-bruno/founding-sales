-- ---------------------------------------------------------------------------
-- 0021_compat_cleanup.sql — the compatibility surface goes (lane W3-C2)
--
-- A contract migration, like 0015, 0018 and 0019: both service ranges move to {21, 21}
-- in the same release (`packages/domain/db/schemaRange.ts`), and the release is a
-- stop-migrate-start one (`infra/scripts/deploy.sh release --schema-change`, which
-- applies this AFTER the Terraform apply with both services at zero). The images of the
-- previous release declare {20, 20} and refuse this schema at startup; nothing of
-- theirs runs while it is applied.
--
-- The release that carries it raises the API's client minimum to 1.0.14. Everything
-- below is a thing only a build older than that reads or writes, which is why the two
-- have to travel together: the minimum is what makes the removal safe, and the removal
-- is what makes the minimum worth raising.
--
-- `fss admin schema-preflight 0021` prints, read-only and while both services are still
-- running, every count below: the enrollment rows that would make this file refuse, and
-- the credential and generation rows it will destroy. It exits 3 when this file would
-- refuse, so the release chain stops before the services do.
--
-- ## What goes
--
--   (a) The `review_required` enrollment state and the column that belonged to it.
--       Wave 2 (S4.1) made a long hold resume on its own; nothing has written the state
--       since, and no installed build shows the review that read it. A row still in it
--       makes this file refuse (below) rather than be rewritten, because deciding what
--       to do with a live enrollment waiting for a person is David's decision and not a
--       migration's. `sequence_enrollments_state_known` and
--       `sequence_enrollments_live_has_no_end` narrow to the three states that remain;
--       `review_union_milliseconds` stays as a column and becomes null-only, because
--       dropping a column desktop 1.0.14 still parses on the wire would be a wire
--       change and this is not one — the API answers the field as a constant `null`.
--   (b) `device_refresh_credentials`, and `devices.credential_generation` with its
--       CHECK. The rotating refresh credential is gone: nothing has renewed with it
--       since desktop 1.0.12, `POST /auth/session/open` takes the device secret — which
--       does not rotate — and `POST /auth/session/renew` is not served any more. Rows
--       here are digests of credentials nothing will present, so they are dropped
--       rather than counted: the preflight reports how many there were, and reporting
--       is all a person needs, because a spent digest proves nothing once the path that
--       would have accepted it is gone.
--   (c) `system_generations`. The system-generation pin went with lane W3-S8 on 26
--       September 2026: a restore is a runbook (`docs/greenfield/runbooks/restore.md`),
--       `/diagnostics.restore` answers neutral constants, and nothing reads or compares
--       a generation. The seeded row 0001 wrote is the only row production has.
--
-- ## What is kept, deliberately
--
--   * The `sessions` end-reason value `credential_reuse`. Stored rows may hold it — a
--     device revoked for presenting a spent generation ended its sessions with it — and
--     narrowing the CHECK would rewrite history rather than remove a capability. No
--     code can write it any more.
--   * All three restore markers (`restore_in_progress` is a live hold and a runbook
--     check, `restore_point` binds reconciliation, `hold.restore_opened` is read when
--     clearing holds) and `review_union_milliseconds` itself, as above.
--
-- ## What is added
--
--   * `sessions_signed_out_by_device`. `signedOutBefore` asks, on every open, whether
--     this device has ever signed out — over every session it has held, not only its
--     newest. `sessions_active_by_device` cannot answer it: that index is partial on
--     `status = 'active'`, and a signed-out session is `ended`. One partial index on the
--     rows that carry the answer.
--
-- ## The refusal (FS021)
--
-- If any enrollment is still `review_required` when this runs, the block below raises
-- FS021 with the count and the row ids and changes nothing — the release stops with
-- schema 20 intact, and the coordinator decides with David before this file is amended
-- (it has not been applied anywhere then). There is no override switch. Nothing else
-- refuses: (b) and (c) destroy rows whose meaning the release removes, and the
-- preflight reports their counts so that nobody is surprised by the number.
--
-- ## One transaction
--
-- The runner applies this file inside one transaction, so a refusal or any failure
-- leaves schema 20 as it was.
-- ---------------------------------------------------------------------------

DO $refuse$
DECLARE
  v_review_required bigint;
  v_ids text;
BEGIN
  SELECT count(*) INTO v_review_required FROM sequence_enrollments WHERE state = 'review_required';
  IF v_review_required > 0 THEN
    -- The ids, so the coordinator can look at exactly these rows. Ten of them at most:
    -- `fss migrate` logs the MESSAGE as a bounded value, and the DETAIL carries the count.
    SELECT string_agg(id::text, ',' ORDER BY id) INTO v_ids
      FROM (SELECT id FROM sequence_enrollments WHERE state = 'review_required' ORDER BY id LIMIT 10) AS first_ten;
    RAISE EXCEPTION USING
      ERRCODE = 'FS021',
      MESSAGE = '0021 refused: review_required_enrollments=' || v_review_required,
      DETAIL = 'first ids: ' || v_ids,
      HINT = 'a long hold resumes on its own since wave 2 (S4.1); resume or stop these enrollments, then run the preflight again';
  END IF;
END
$refuse$;

-- ---------------------------------------------------------------------------
-- (a) The enrollment state and its column
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_enrollments
  DROP CONSTRAINT sequence_enrollments_state_known,
  ADD CONSTRAINT sequence_enrollments_state_known
    CHECK (state IN ('active', 'completed', 'stopped')),
  DROP CONSTRAINT sequence_enrollments_live_has_no_end,
  ADD CONSTRAINT sequence_enrollments_live_has_no_end
    CHECK ((state = 'active') = (ended_at IS NULL)),
  DROP CONSTRAINT sequence_enrollments_review_union_present,
  ADD CONSTRAINT sequence_enrollments_review_union_present
    CHECK (review_union_milliseconds IS NULL);

-- ---------------------------------------------------------------------------
-- (b) The rotating refresh credential
-- ---------------------------------------------------------------------------
DROP TABLE device_refresh_credentials;

ALTER TABLE devices
  DROP CONSTRAINT devices_credential_generation_positive,
  DROP COLUMN credential_generation;

-- ---------------------------------------------------------------------------
-- (c) The system generation
-- ---------------------------------------------------------------------------
DROP TABLE system_generations;

-- ---------------------------------------------------------------------------
-- The index `signedOutBefore` asks for
-- ---------------------------------------------------------------------------
CREATE INDEX sessions_signed_out_by_device
  ON sessions (workspace_id, device_id)
  WHERE end_reason = 'signed_out';
