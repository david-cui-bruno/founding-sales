-- changes: phone_owner_risk_receipts, phone_routes, phone_handoff_attempts
-- David's dated decision is recorded once by trusted private operations, not here.
CREATE TABLE phone_owner_risk_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 owner_user_id uuid NOT NULL,
 policy_version text NOT NULL DEFAULT 'owner-uncovered-office-v1' CHECK(policy_version='owner-uncovered-office-v1'),
 decision_at timestamptz NOT NULL UNIQUE CHECK(decision_at='2026-10-19T22:15:31.941Z'),
 approval_reference text NOT NULL UNIQUE CHECK(approval_reference='david-20261019-221531-uncovered-office-iphone-v1'),
 self_test_firm_id uuid,
 self_test_e164 text CHECK(self_test_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 self_test_erased_at timestamptz,
 covered_area_codes text[] NOT NULL DEFAULT ARRAY['401','508','617','774','857']::text[],
 subscription_expires_on date NOT NULL DEFAULT DATE '2027-08-31' CHECK(subscription_expires_on=DATE '2027-08-31'),
 warning_version text NOT NULL DEFAULT 'national-dnc-unchecked-v1' CHECK(warning_version='national-dnc-unchecked-v1'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 valid_until timestamptz,
 revoked_at timestamptz,
 revocation_reference text CHECK(length(btrim(revocation_reference)) BETWEEN 1 AND 200),
 PRIMARY KEY(workspace_id,id), UNIQUE(policy_version),
 FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,self_test_firm_id) REFERENCES firms(workspace_id,id),
 CHECK((self_test_erased_at IS NULL AND self_test_firm_id IS NOT NULL AND self_test_e164 IS NOT NULL)
  OR (self_test_erased_at IS NOT NULL AND self_test_firm_id IS NULL AND self_test_e164 IS NULL AND self_test_erased_at>=recorded_at)),
 CHECK(covered_area_codes=ARRAY['401','508','617','774','857']::text[]),
 CHECK(recorded_at>=decision_at AND (valid_until IS NULL OR valid_until>recorded_at)),
 CHECK((revoked_at IS NULL)=(revocation_reference IS NULL)),
 CHECK(revoked_at IS NULL OR revoked_at>=recorded_at)
);
REVOKE ALL ON phone_owner_risk_receipts FROM PUBLIC,app_runtime,migration;
GRANT SELECT ON phone_owner_risk_receipts TO app_runtime,migration;
GRANT INSERT ON phone_owner_risk_receipts TO migration;
GRANT UPDATE(revoked_at,revocation_reference) ON phone_owner_risk_receipts TO migration;
GRANT UPDATE(self_test_firm_id,self_test_e164,self_test_erased_at) ON phone_owner_risk_receipts TO app_runtime,migration;
CREATE FUNCTION phone_owner_risk_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Owner risk audit cannot be deleted'; END IF;
 -- Trusted operations take gate FIRST. Never wait holding a receipt row.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('fss.send-gate:'||NEW.workspace_id::text,0)) THEN
  RAISE EXCEPTION 'Retry owner risk operation gate-first' USING ERRCODE='40001';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id
    AND user_id=NEW.owner_user_id AND status='active' AND role='admin' FOR SHARE) THEN
   RAISE EXCEPTION 'Current exact owner required' USING ERRCODE='23514';
  END IF;
 ELSIF OLD.self_test_erased_at IS NULL AND NEW.self_test_erased_at IS NOT NULL
   AND NEW.self_test_firm_id IS NULL AND NEW.self_test_e164 IS NULL
   AND (to_jsonb(NEW)-ARRAY['self_test_firm_id','self_test_e164','self_test_erased_at']) IS NOT DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['self_test_firm_id','self_test_e164','self_test_erased_at']) THEN
  NEW.self_test_erased_at:=clock_timestamp();
 ELSIF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
   OR (to_jsonb(NEW)-ARRAY['revoked_at','revocation_reference']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['revoked_at','revocation_reference']) THEN
  RAISE EXCEPTION 'Receipt allows only one revocation or null-only self-test erasure' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER phone_owner_risk_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON phone_owner_risk_receipts FOR EACH ROW EXECUTE FUNCTION phone_owner_risk_receipt_guard();
-- Restrictive negative fact, never positive office proof.
ALTER TABLE phone_routes ADD COLUMN known_personal_cell_at timestamptz;
CREATE FUNCTION phone_route_personal_cell_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.known_personal_cell_at IS NOT NULL AND NEW.known_personal_cell_at IS DISTINCT FROM OLD.known_personal_cell_at THEN
  RAISE EXCEPTION 'Known personal cell requires separately reviewed correction' USING ERRCODE='23514';
 END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('fss.send-gate:'||NEW.workspace_id::text,0)) THEN
  RAISE EXCEPTION 'Retry personal cell restriction gate-first' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER phone_route_personal_cell_guard BEFORE UPDATE OF known_personal_cell_at ON phone_routes
 FOR EACH ROW EXECUTE FUNCTION phone_route_personal_cell_guard();
ALTER TABLE phone_handoff_attempts
 ADD COLUMN national_dnc_basis text NOT NULL DEFAULT 'registry',
 ADD COLUMN owner_risk_receipt_id uuid,
 ADD COLUMN owner_risk_firm_id uuid,
 ADD COLUMN office_proof_kind text,
 ADD COLUMN office_proof_id uuid,
 ADD COLUMN office_proof_expires_at timestamptz,
 ADD CONSTRAINT phone_handoff_owner_risk_receipt_fk FOREIGN KEY(workspace_id,owner_risk_receipt_id)
  REFERENCES phone_owner_risk_receipts(workspace_id,id),
 ADD CONSTRAINT phone_handoff_national_dnc_basis CHECK(national_dnc_basis IN ('registry','office_owner_risk','owner_self_test')),
 ADD CONSTRAINT phone_handoff_owner_risk_shape CHECK(
  (national_dnc_basis='registry' AND owner_risk_receipt_id IS NULL AND owner_risk_firm_id IS NULL
   AND office_proof_kind IS NULL AND office_proof_id IS NULL AND office_proof_expires_at IS NULL)
  OR (national_dnc_basis='owner_self_test' AND owner_risk_receipt_id IS NOT NULL AND owner_risk_firm_id IS NOT NULL
   AND office_proof_kind IS NULL AND office_proof_id IS NULL AND office_proof_expires_at IS NULL)
  OR (national_dnc_basis='office_owner_risk' AND owner_risk_receipt_id IS NOT NULL AND owner_risk_firm_id IS NOT NULL
   AND ((erased_at IS NOT NULL AND office_proof_kind IS NULL AND office_proof_id IS NULL AND office_proof_expires_at IS NULL)
    OR (erased_at IS NULL AND office_proof_kind IN ('admission','office_assessment') AND office_proof_kind IS NOT NULL
     AND office_proof_id IS NOT NULL AND office_proof_expires_at IS NOT NULL AND expires_at<=office_proof_expires_at))));
-- No erased_at predicate: self-test consumption survives erasure permanently.
CREATE UNIQUE INDEX phone_handoff_one_owner_self_test ON phone_handoff_attempts(owner_risk_receipt_id)
 WHERE national_dnc_basis='owner_self_test';
ALTER TABLE phone_handoff_attempts DROP CONSTRAINT phone_handoff_attempts_check2;
ALTER TABLE phone_handoff_attempts ADD CONSTRAINT phone_handoff_evidence_union CHECK(
 (erased_at IS NULL AND e164 IS NOT NULL AND phone_route_id IS NOT NULL AND route_version IS NOT NULL
  AND ((national_dnc_basis='registry' AND registry_snapshot_id IS NOT NULL AND registry_scrubbed_at IS NOT NULL)
   OR (national_dnc_basis IN ('office_owner_risk','owner_self_test') AND registry_snapshot_id IS NULL AND registry_scrubbed_at IS NULL)))
 OR (erased_at IS NOT NULL AND e164 IS NULL AND phone_route_id IS NULL AND route_version IS NULL
  AND contact_id IS NULL AND opportunity_id IS NULL AND item_id IS NULL
  AND registry_snapshot_id IS NULL AND registry_scrubbed_at IS NULL AND call_log_id IS NULL));
CREATE FUNCTION phone_handoff_owner_risk_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt phone_owner_risk_receipts%ROWTYPE; tick timestamptz;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Attempt history cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.national_dnc_basis,NEW.owner_risk_receipt_id,NEW.owner_risk_firm_id)
    IS DISTINCT FROM ROW(OLD.national_dnc_basis,OLD.owner_risk_receipt_id,OLD.owner_risk_firm_id) THEN
   RAISE EXCEPTION 'Attempt authority and consumption are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.national_dnc_basis<>'registry' THEN
   IF ROW(NEW.workspace_id,NEW.id,NEW.actor_user_id,NEW.device_id,NEW.command_id,NEW.reserved_at,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.actor_user_id,OLD.device_id,OLD.command_id,OLD.reserved_at,OLD.expires_at)
     OR (OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at)
     OR (NEW.erased_at IS NULL AND ROW(NEW.e164,NEW.phone_route_id,NEW.route_version,NEW.office_proof_kind,NEW.office_proof_id,NEW.office_proof_expires_at)
      IS DISTINCT FROM ROW(OLD.e164,OLD.phone_route_id,OLD.route_version,OLD.office_proof_kind,OLD.office_proof_id,OLD.office_proof_expires_at)) THEN
    RAISE EXCEPTION 'Frozen owner risk attempt cannot be rewritten' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.national_dnc_basis='registry' THEN RETURN NEW; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('fss.send-gate:'||NEW.workspace_id::text,0)) THEN
  RAISE EXCEPTION 'Retry owner risk admission gate-first' USING ERRCODE='40001';
 END IF;
 IF NEW.erased_at IS NOT NULL OR NEW.firm_id IS DISTINCT FROM NEW.owner_risk_firm_id THEN
  RAISE EXCEPTION 'Owner risk needs live exact firm' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM phone_routes r JOIN firms f ON f.workspace_id=r.workspace_id AND f.id=r.firm_id
   WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.phone_route_id AND r.firm_id=NEW.firm_id
    AND r.version=NEW.route_version AND r.e164=NEW.e164 AND r.retired_at IS NULL AND r.eligibility IN ('candidate','usable')
    AND f.status='active' AND f.assigned_user_id=NEW.actor_user_id
    AND (NEW.national_dnc_basis='owner_self_test' OR r.known_personal_cell_at IS NULL) FOR SHARE OF r,f) THEN
  RAISE EXCEPTION 'Current route and assignment required' USING ERRCODE='23514';
 END IF;
 SELECT * INTO receipt FROM phone_owner_risk_receipts WHERE workspace_id=NEW.workspace_id
  AND id=NEW.owner_risk_receipt_id FOR SHARE;
 IF NOT FOUND OR receipt.owner_user_id<>NEW.actor_user_id OR receipt.revoked_at IS NOT NULL
   OR NEW.e164 !~ '^\+1[2-9][0-9]{9}$' OR substring(NEW.e164 FROM 3 FOR 3)=ANY(receipt.covered_area_codes) THEN
  RAISE EXCEPTION 'Exact uncovered owner policy required' USING ERRCODE='23514';
 END IF;
 IF NEW.national_dnc_basis='office_owner_risk' AND (NEW.firm_id=receipt.self_test_firm_id OR NEW.e164=receipt.self_test_e164) THEN
  RAISE EXCEPTION 'Owner self number cannot masquerade as office proof' USING ERRCODE='23514';
 END IF;
 IF NEW.national_dnc_basis='owner_self_test' AND (receipt.self_test_erased_at IS NOT NULL
   OR receipt.self_test_firm_id IS NULL OR receipt.self_test_e164 IS NULL
   OR NEW.firm_id<>receipt.self_test_firm_id OR NEW.e164<>receipt.self_test_e164) THEN
  RAISE EXCEPTION 'Self test endpoint mismatch' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM devices WHERE workspace_id=NEW.workspace_id AND id=NEW.device_id
   AND user_id=NEW.actor_user_id AND status='active' FOR SHARE) THEN
  RAISE EXCEPTION 'Current exact device required' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=NEW.workspace_id
   AND user_id=NEW.actor_user_id AND status='active' AND role='admin' FOR SHARE) THEN
  RAISE EXCEPTION 'Current exact owner required' USING ERRCODE='23514';
 END IF;
 tick:=clock_timestamp();
 IF tick<receipt.recorded_at OR tick>=NEW.expires_at OR NEW.reserved_at>tick
   OR NEW.reserved_at<receipt.recorded_at OR (receipt.valid_until IS NOT NULL AND NEW.expires_at>receipt.valid_until) THEN
  RAISE EXCEPTION 'Owner policy or handoff expired' USING ERRCODE='23514';
 END IF;
 -- Office proof audit references have no FK: evidence erasure must not delete cadence.
 -- Application verifier locks and recomputes proof and personal-cell negatives.
 RETURN NEW;
END; $$;
CREATE TRIGGER phone_handoff_owner_risk_guard BEFORE INSERT OR UPDATE OR DELETE ON phone_handoff_attempts
 FOR EACH ROW EXECUTE FUNCTION phone_handoff_owner_risk_guard();
REVOKE ALL ON FUNCTION phone_owner_risk_receipt_guard(),phone_handoff_owner_risk_guard(),phone_route_personal_cell_guard() FROM PUBLIC;
