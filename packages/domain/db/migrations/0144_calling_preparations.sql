-- changes: calling_preparations, firms, phone_routes, dial_tickets, phone_handoff_attempts
-- ADR0028: source-bound unqualified company preparation. No acquisition authority.
CREATE TABLE calling_preparations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 candidate_ref uuid NOT NULL, candidate_revision integer NOT NULL CHECK(candidate_revision>0),
 discovery_run_ref uuid NOT NULL, source_creator_ref uuid NOT NULL, prepared_by_ref uuid NOT NULL,
 firm_ref uuid NOT NULL, route_ref uuid NOT NULL, firm_id uuid, phone_route_id uuid,
 research_hold_id uuid, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'live' CHECK(state IN('live','erased')),
 route_version integer NOT NULL DEFAULT 1 CHECK(route_version>0),
 choice jsonb, source_url_hashes text[], profile_hash text,
 source_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 erased_at timestamptz, erase_reason text,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,candidate_ref), UNIQUE(workspace_id,firm_ref), UNIQUE(workspace_id,route_ref),
 FOREIGN KEY(workspace_id,firm_id) REFERENCES firms(workspace_id,id) ON DELETE SET NULL(firm_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,phone_route_id) REFERENCES phone_routes(workspace_id,id) ON DELETE SET NULL(phone_route_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,research_hold_id) REFERENCES active_holds(workspace_id,id),
 CHECK((firm_id IS NULL OR firm_id=firm_ref) AND(phone_route_id IS NULL OR phone_route_id=route_ref)),
 CHECK(isfinite(created_at) AND isfinite(updated_at) AND isfinite(source_expires_at) AND updated_at>=created_at
  AND source_expires_at>created_at AND(erased_at IS NULL OR(isfinite(erased_at) AND erased_at>=created_at))),
 CHECK(erase_reason IS NULL OR erase_reason IN('source_deleted','source_expired','source_not_permitted','source_changed',
  'choice_withdrawn','candidate_changed','creator_inactive','firm_changed','route_changed','firm_deleted')),
 CHECK(((state='live' AND erased_at IS NULL AND erase_reason IS NULL AND firm_id IS NOT NULL AND phone_route_id IS NOT NULL
  AND jsonb_typeof(choice)='object' AND choice->>'runId'=discovery_run_ref::text
  AND profile_hash~'^[0-9a-f]{64}$' AND cardinality(source_url_hashes) BETWEEN 1 AND 23
  AND array_position(source_url_hashes,NULL) IS NULL
  AND array_to_string(source_url_hashes,',')~'^[0-9a-f]{64}(,[0-9a-f]{64}){0,22}$')
  OR(state='erased' AND erased_at IS NOT NULL AND erase_reason IS NOT NULL
   AND choice IS NULL AND source_url_hashes IS NULL AND profile_hash IS NULL)) IS TRUE)
);
CREATE INDEX calling_preparations_expiry ON calling_preparations(workspace_id,source_expires_at,id) WHERE state='live';
ALTER TABLE firms ADD COLUMN calling_preparation_id uuid, ADD COLUMN calling_preparation_erased_at timestamptz;
ALTER TABLE phone_routes ADD COLUMN calling_preparation_id uuid, ADD COLUMN calling_preparation_erased_at timestamptz,
 ALTER COLUMN e164 DROP NOT NULL;
ALTER TABLE dial_tickets ADD COLUMN calling_preparation_id uuid, ADD COLUMN calling_preparation_erased_at timestamptz,
 ALTER COLUMN e164 DROP NOT NULL, ALTER COLUMN firm_time_zone DROP NOT NULL;
ALTER TABLE phone_handoff_attempts ADD COLUMN calling_preparation_id uuid;
ALTER TABLE firms ADD FOREIGN KEY(workspace_id,calling_preparation_id) REFERENCES calling_preparations(workspace_id,id);
ALTER TABLE phone_routes ADD FOREIGN KEY(workspace_id,calling_preparation_id) REFERENCES calling_preparations(workspace_id,id);
ALTER TABLE dial_tickets ADD FOREIGN KEY(workspace_id,calling_preparation_id) REFERENCES calling_preparations(workspace_id,id);
ALTER TABLE phone_handoff_attempts ADD FOREIGN KEY(workspace_id,calling_preparation_id) REFERENCES calling_preparations(workspace_id,id);
ALTER TABLE firms ADD CONSTRAINT firms_preparation_erasure CHECK(
 calling_preparation_erased_at IS NULL OR(calling_preparation_id IS NOT NULL
 AND isfinite(calling_preparation_erased_at) AND calling_preparation_erased_at>=created_at
 AND name IN('[source unavailable company]','[deleted]') AND website IS NULL AND address_line IS NULL
 AND locality IS NULL AND region_code IS NULL AND postal_code IS NULL AND country_code='ZZ'
 AND time_zone IS NULL AND time_zone_confidence IS NULL AND time_zone_source IS NULL
 AND time_zone_rule_version IS NULL AND time_zone_unresolved_reason IS NULL));
ALTER TABLE phone_routes ADD CONSTRAINT phone_routes_preparation_erasure CHECK(
 (calling_preparation_erased_at IS NULL AND e164 IS NOT NULL) OR(calling_preparation_id IS NOT NULL
 AND calling_preparation_erased_at IS NOT NULL AND isfinite(calling_preparation_erased_at)
 AND calling_preparation_erased_at>=created_at AND e164 IS NULL AND eligibility='retired' AND retired_at IS NOT NULL));
ALTER TABLE dial_tickets ADD CONSTRAINT dial_tickets_preparation_erasure CHECK(
 (calling_preparation_erased_at IS NULL AND e164 IS NOT NULL AND firm_time_zone IS NOT NULL)
 OR(calling_preparation_id IS NOT NULL AND calling_preparation_erased_at IS NOT NULL
 AND isfinite(calling_preparation_erased_at) AND calling_preparation_erased_at>=issued_at AND e164 IS NULL AND firm_time_zone IS NULL));

-- Permanent prepared-only outcome fact, independent of erasable call_log_id.
-- Source and whole-Firm erasure may clear that FK without making a new report due.
ALTER TABLE phone_handoff_attempts ADD COLUMN calling_preparation_outcome_recorded_at timestamptz;
ALTER TABLE phone_handoff_attempts ADD CONSTRAINT phone_handoff_prepared_outcome_once CHECK(
 calling_preparation_outcome_recorded_at IS NULL OR(calling_preparation_id IS NOT NULL
 AND isfinite(calling_preparation_outcome_recorded_at) AND calling_preparation_outcome_recorded_at>=reserved_at));

-- A source-erased prepared attempt may append one opaque actual-history link.
-- Endpoint/proof/context bindings stay erased; deferred counterpart checks below
-- verify that this is the exact original Firm/route/actor, never full deletion.
ALTER TABLE phone_handoff_attempts DROP CONSTRAINT phone_handoff_evidence_union;
ALTER TABLE phone_handoff_attempts ADD CONSTRAINT phone_handoff_evidence_union CHECK(
 (erased_at IS NULL AND e164 IS NOT NULL AND phone_route_id IS NOT NULL AND route_version IS NOT NULL
  AND((national_dnc_basis='registry' AND registry_snapshot_id IS NOT NULL AND registry_scrubbed_at IS NOT NULL)
   OR(national_dnc_basis IN('office_owner_risk','owner_self_test') AND registry_snapshot_id IS NULL AND registry_scrubbed_at IS NULL)))
 OR(erased_at IS NOT NULL AND e164 IS NULL AND phone_route_id IS NULL AND route_version IS NULL
  AND contact_id IS NULL AND opportunity_id IS NULL AND item_id IS NULL AND registry_snapshot_id IS NULL AND registry_scrubbed_at IS NULL
  AND(call_log_id IS NULL OR calling_preparation_id IS NOT NULL)));

CREATE FUNCTION calling_preparation_profile_hash(w uuid,f uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(name,website,address_line,locality,region_code,postal_code,country_code,
  time_zone,time_zone_confidence,time_zone_source,time_zone_rule_version,time_zone_unresolved_reason)::text,'UTF8')),'hex')
 FROM firms WHERE workspace_id=w AND id=f
$$;
CREATE FUNCTION calling_preparation_lock_held(lock_name text,wanted_mode text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode=wanted_mode
 AND objsubid=1 AND classid::bigint=((hashtextextended(lock_name,0)>>32)&4294967295)
 AND objid::bigint=(hashtextextended(lock_name,0)&4294967295))
$$;
CREATE FUNCTION require_calling_preparation_cleanup_locks(w uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT calling_preparation_lock_held('sourcing-discovery-review:'||w::text,'ExclusiveLock')
 OR NOT calling_preparation_lock_held('fss.send-gate:'||w::text,'ExclusiveLock')
 OR NOT(calling_preparation_lock_held('today.build:'||w::text,'ShareLock')
  OR calling_preparation_lock_held('today.build:'||w::text,'ExclusiveLock')) THEN
  RAISE EXCEPTION 'Preparation cleanup requires registered source/gate/Today custody before rows' USING ERRCODE='40001';
 END IF;
END $$;
CREATE FUNCTION calling_preparation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preparation denial history is permanent' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'live' OR NEW.revision<>1 OR NEW.source_expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'Preparation must begin current and live' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.workspace_id,NEW.id,NEW.candidate_ref,NEW.candidate_revision,NEW.discovery_run_ref,NEW.source_creator_ref,
  NEW.prepared_by_ref,NEW.firm_ref,NEW.route_ref,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.workspace_id,OLD.id,OLD.candidate_ref,OLD.candidate_revision,OLD.discovery_run_ref,OLD.source_creator_ref,
  OLD.prepared_by_ref,OLD.firm_ref,OLD.route_ref,OLD.created_at)
 OR NEW.source_expires_at>OLD.source_expires_at OR NEW.route_version<OLD.route_version
 OR(OLD.research_hold_id IS NOT NULL AND NEW.research_hold_id IS DISTINCT FROM OLD.research_hold_id)
 OR(NEW.firm_id IS NOT NULL AND NEW.firm_id IS DISTINCT FROM OLD.firm_id)
 OR(NEW.phone_route_id IS NOT NULL AND NEW.phone_route_id IS DISTINCT FROM OLD.phone_route_id) THEN
  RAISE EXCEPTION 'Preparation cannot rebind or extend' USING ERRCODE='23514'; END IF;
 IF OLD.state='erased' THEN
  IF(to_jsonb(NEW)-ARRAY['firm_id','phone_route_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['firm_id','phone_route_id']) THEN
   RAISE EXCEPTION 'Preparation erasure cannot reset' USING ERRCODE='23514'; END IF;
 ELSIF NEW.state='live' AND(NEW.choice IS DISTINCT FROM OLD.choice OR NEW.source_url_hashes IS DISTINCT FROM OLD.source_url_hashes) THEN
  RAISE EXCEPTION 'Live profile review cannot replace its choice' USING ERRCODE='23514';
 ELSIF NEW.revision<>OLD.revision+1 AND NOT(OLD.research_hold_id IS NULL AND NEW.revision=OLD.revision) THEN
  RAISE EXCEPTION 'Preparation update requires its next revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON calling_preparations
 FOR EACH ROW EXECUTE FUNCTION calling_preparation_identity_guard();

-- Validate each supplied or omitted marker immediately, including a second Firm
-- attempting to claim another preparation. Deferred checks below cover terminal
-- consistency across ALL counterparts, regardless of which row changed first.
CREATE FUNCTION calling_preparation_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p calling_preparations%ROWTYPE; expected_owner uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.calling_preparation_id IS DISTINCT FROM OLD.calling_preparation_id THEN
   RAISE EXCEPTION 'Preparation copy ownership is immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME<>'phone_handoff_attempts' THEN
   IF OLD.calling_preparation_erased_at IS NOT NULL AND NEW.calling_preparation_erased_at IS DISTINCT FROM OLD.calling_preparation_erased_at THEN
    RAISE EXCEPTION 'Preparation erased bytes cannot reset' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='phone_routes' THEN
  SELECT calling_preparation_id INTO expected_owner FROM firms WHERE workspace_id=NEW.workspace_id AND id=NEW.firm_id;
 ELSIF TG_TABLE_NAME IN('dial_tickets','phone_handoff_attempts') THEN
  SELECT calling_preparation_id INTO expected_owner FROM firms WHERE workspace_id=NEW.workspace_id AND id=NEW.firm_id;
 END IF;
 IF TG_TABLE_NAME<>'firms' AND NEW.calling_preparation_id IS DISTINCT FROM expected_owner THEN
  RAISE EXCEPTION 'Prepared counterpart cannot omit its exact owner' USING ERRCODE='23514'; END IF;
 IF NEW.calling_preparation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM calling_preparations WHERE workspace_id=NEW.workspace_id AND id=NEW.calling_preparation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preparation owner missing' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='firms' THEN
  IF NEW.id<>p.firm_ref THEN RAISE EXCEPTION 'Preparation owns exactly one Firm' USING ERRCODE='23514'; END IF;
 ELSIF NEW.firm_id<>p.firm_ref THEN RAISE EXCEPTION 'Prepared counterpart Firm mismatch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='phone_routes' THEN
  IF NEW.id<>p.route_ref OR NEW.contact_id IS NOT NULL THEN RAISE EXCEPTION 'Preparation owns exactly one company route' USING ERRCODE='23514'; END IF;
  IF NEW.source<>'website' OR NEW.technical_validation<>'unknown' OR NEW.association_confidence IS NOT NULL THEN
   RAISE EXCEPTION 'Preparation grants no independent route qualification' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.eligibility='retired' AND(NEW.eligibility<>'retired' OR NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retired_reason IS DISTINCT FROM OLD.retired_reason) THEN
    RAISE EXCEPTION 'Prepared route retirement cannot revive or lose its actual stop' USING ERRCODE='23514'; END IF;
   IF ROW(NEW.source,NEW.retrieved_at,NEW.technical_validation,NEW.association_confidence)
    IS DISTINCT FROM ROW(OLD.source,OLD.retrieved_at,OLD.technical_validation,OLD.association_confidence) THEN
    RAISE EXCEPTION 'Prepared source route observations are immutable' USING ERRCODE='23514'; END IF;
   IF NEW.e164 IS DISTINCT FROM OLD.e164 AND NEW.calling_preparation_erased_at IS NULL THEN
    RAISE EXCEPTION 'Same-choice review cannot replace endpoint' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='dial_tickets' THEN
  IF NEW.phone_route_id<>p.route_ref THEN RAISE EXCEPTION 'Prepared ticket route mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.expires_at>p.source_expires_at THEN RAISE EXCEPTION 'Prepared ticket outlives original source' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF(to_jsonb(NEW)-ARRAY['consumed_at','e164','firm_time_zone','calling_preparation_erased_at'])
    IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['consumed_at','e164','firm_time_zone','calling_preparation_erased_at'])
    OR(OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
    OR(NEW.e164 IS DISTINCT FROM OLD.e164 AND NOT(NEW.e164 IS NULL AND NEW.calling_preparation_erased_at IS NOT NULL))
    OR(NEW.firm_time_zone IS DISTINCT FROM OLD.firm_time_zone AND NOT(NEW.firm_time_zone IS NULL AND NEW.calling_preparation_erased_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Prepared ticket identity is frozen' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='phone_handoff_attempts' THEN
  IF TG_OP='INSERT' AND NEW.calling_preparation_outcome_recorded_at IS NOT NULL THEN
   RAISE EXCEPTION 'Prepared outcome marker starts empty' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.calling_preparation_outcome_recorded_at IS NOT NULL AND NEW.calling_preparation_outcome_recorded_at IS DISTINCT FROM OLD.calling_preparation_outcome_recorded_at
    OR OLD.calling_preparation_outcome_recorded_at IS NULL AND NEW.calling_preparation_outcome_recorded_at IS NOT NULL AND NEW.call_log_id IS NULL
    OR OLD.calling_preparation_outcome_recorded_at IS NOT NULL AND OLD.call_log_id IS NULL AND NEW.call_log_id IS NOT NULL
    OR OLD.call_log_id IS NOT NULL AND NEW.call_log_id IS NOT NULL AND NEW.call_log_id IS DISTINCT FROM OLD.call_log_id THEN
    RAISE EXCEPTION 'Prepared actual outcome cannot reset or link a second time' USING ERRCODE='23514'; END IF;
   IF NEW.call_log_id IS NOT NULL AND NEW.calling_preparation_outcome_recorded_at IS NULL THEN
    RAISE EXCEPTION 'Prepared history link requires its same-write outcome fact' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.erased_at IS NOT NULL AND NEW.call_log_id IS DISTINCT FROM OLD.call_log_id THEN
   PERFORM require_calling_preparation_cleanup_locks(NEW.workspace_id);
   IF OLD.call_log_id IS NOT NULL AND NEW.call_log_id IS NOT NULL THEN
    RAISE EXCEPTION 'Prepared historical attempt can link only once' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.erased_at IS NULL AND NEW.phone_route_id IS DISTINCT FROM p.route_ref THEN
   RAISE EXCEPTION 'Prepared handoff route mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NEW.expires_at>p.source_expires_at THEN RAISE EXCEPTION 'Prepared handoff outlives original source' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER firms_preparation_copy_guard BEFORE INSERT OR UPDATE ON firms FOR EACH ROW EXECUTE FUNCTION calling_preparation_copy_guard();
CREATE TRIGGER routes_preparation_copy_guard BEFORE INSERT OR UPDATE ON phone_routes FOR EACH ROW EXECUTE FUNCTION calling_preparation_copy_guard();
CREATE TRIGGER tickets_preparation_copy_guard BEFORE INSERT OR UPDATE ON dial_tickets FOR EACH ROW EXECUTE FUNCTION calling_preparation_copy_guard();
CREATE TRIGGER handoffs_preparation_copy_guard BEFORE INSERT OR UPDATE ON phone_handoff_attempts FOR EACH ROW EXECUTE FUNCTION calling_preparation_copy_guard();

CREATE FUNCTION calling_preparation_alias_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.record_kind='firm' AND EXISTS(SELECT 1 FROM calling_preparations WHERE workspace_id=NEW.workspace_id AND firm_ref=NEW.firm_id) THEN
  RAISE EXCEPTION 'Prepared company cannot acquire independent identity aliases' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_alias_guard BEFORE INSERT OR UPDATE ON record_aliases FOR EACH ROW EXECUTE FUNCTION calling_preparation_alias_guard();

CREATE FUNCTION assert_calling_preparation_consistent(w uuid,pid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p calling_preparations%ROWTYPE;
BEGIN
 SELECT * INTO p FROM calling_preparations WHERE workspace_id=w AND id=pid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preparation binding missing' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM firms WHERE workspace_id=w AND calling_preparation_id=pid AND id<>p.firm_ref)
 OR EXISTS(SELECT 1 FROM phone_routes WHERE workspace_id=w AND calling_preparation_id=pid AND(id<>p.route_ref OR firm_id<>p.firm_ref OR contact_id IS NOT NULL))
 OR EXISTS(SELECT 1 FROM dial_tickets WHERE workspace_id=w AND calling_preparation_id=pid AND(firm_id<>p.firm_ref OR phone_route_id<>p.route_ref))
 OR EXISTS(SELECT 1 FROM phone_handoff_attempts WHERE workspace_id=w AND calling_preparation_id=pid AND(firm_id<>p.firm_ref OR(erased_at IS NULL AND phone_route_id IS DISTINCT FROM p.route_ref))) THEN
  RAISE EXCEPTION 'Prepared counterpart ownership mismatch' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM phone_handoff_attempts h WHERE h.workspace_id=w AND h.calling_preparation_id=pid AND h.erased_at IS NULL
  AND((h.calling_preparation_outcome_recorded_at IS NULL)<>(h.call_log_id IS NULL))) THEN
  RAISE EXCEPTION 'Live prepared outcome fact and original link must agree' USING ERRCODE='23514'; END IF;
 -- An erased-copy flag cannot exempt retained bytes from later cleanup. Check
 -- this in live and terminal preparations, from every counterpart's deferred hook.
 IF EXISTS(SELECT 1 FROM dial_tickets WHERE workspace_id=w AND calling_preparation_id=pid AND calling_preparation_erased_at IS NOT NULL
  AND(e164 IS NOT NULL OR firm_time_zone IS NOT NULL))
 OR EXISTS(SELECT 1 FROM phone_handoff_attempts WHERE workspace_id=w AND calling_preparation_id=pid AND erased_at IS NOT NULL
  AND(e164 IS NOT NULL OR phone_route_id IS NOT NULL OR route_version IS NOT NULL OR contact_id IS NOT NULL OR opportunity_id IS NOT NULL
   OR item_id IS NOT NULL OR registry_snapshot_id IS NOT NULL OR registry_scrubbed_at IS NOT NULL
   OR office_proof_kind IS NOT NULL OR office_proof_id IS NOT NULL OR office_proof_expires_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'Erased preparation copies cannot retain frozen bytes' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM phone_handoff_attempts h WHERE h.workspace_id=w AND h.calling_preparation_id=pid AND h.erased_at IS NOT NULL AND h.call_log_id IS NOT NULL
  AND(p.state<>'erased' OR p.erase_reason='firm_deleted' OR NOT EXISTS(
   SELECT 1 FROM firms f JOIN phone_routes r ON r.workspace_id=f.workspace_id AND r.firm_id=f.id
    JOIN call_logs l ON l.workspace_id=f.workspace_id AND l.firm_id=f.id
   WHERE f.workspace_id=w AND f.id=p.firm_ref AND f.status='active' AND f.name='[source unavailable company]' AND f.calling_preparation_id=pid AND f.calling_preparation_erased_at IS NOT NULL
    AND r.id=p.route_ref AND r.calling_preparation_id=pid AND r.e164 IS NULL AND r.eligibility='retired' AND r.calling_preparation_erased_at IS NOT NULL
    AND l.id=h.call_log_id AND l.actor_user_id=h.actor_user_id AND l.phone_route_id=p.route_ref AND l.contact_id IS NULL AND l.opportunity_id IS NULL))) THEN
  RAISE EXCEPTION 'Erased prepared history needs exact original opaque counterparts' USING ERRCODE='23514'; END IF;
 IF p.state='erased' THEN
  IF EXISTS(SELECT 1 FROM firms WHERE workspace_id=w AND id=p.firm_ref AND(calling_preparation_id IS DISTINCT FROM pid OR calling_preparation_erased_at IS NULL
    OR name NOT IN('[source unavailable company]','[deleted]') OR website IS NOT NULL OR address_line IS NOT NULL OR locality IS NOT NULL
    OR region_code IS NOT NULL OR postal_code IS NOT NULL OR country_code<>'ZZ' OR time_zone IS NOT NULL OR time_zone_confidence IS NOT NULL
    OR time_zone_source IS NOT NULL OR time_zone_rule_version IS NOT NULL OR time_zone_unresolved_reason IS NOT NULL))
  OR EXISTS(SELECT 1 FROM phone_routes WHERE workspace_id=w AND id=p.route_ref AND(calling_preparation_id IS DISTINCT FROM pid
    OR calling_preparation_erased_at IS NULL OR e164 IS NOT NULL OR eligibility<>'retired' OR retired_at IS NULL))
  OR EXISTS(SELECT 1 FROM dial_tickets WHERE workspace_id=w AND calling_preparation_id=pid AND(e164 IS NOT NULL OR firm_time_zone IS NOT NULL OR calling_preparation_erased_at IS NULL))
  OR EXISTS(SELECT 1 FROM phone_handoff_attempts WHERE workspace_id=w AND calling_preparation_id=pid AND(erased_at IS NULL OR e164 IS NOT NULL OR phone_route_id IS NOT NULL)) THEN
   RAISE EXCEPTION 'Terminal preparation must physically erase every owned counterpart' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 IF p.source_expires_at<=clock_timestamp() OR p.research_hold_id IS NULL OR p.profile_hash IS DISTINCT FROM calling_preparation_profile_hash(w,p.firm_ref)
 OR NOT EXISTS(SELECT 1 FROM firms f JOIN phone_routes r ON r.workspace_id=f.workspace_id AND r.firm_id=f.id
  WHERE f.workspace_id=w AND f.id=p.firm_ref AND f.status='active' AND f.calling_preparation_id=pid AND f.calling_preparation_erased_at IS NULL
  AND r.id=p.route_ref AND r.calling_preparation_id=pid AND r.calling_preparation_erased_at IS NULL AND r.e164 IS NOT NULL AND r.version=p.route_version)
 OR NOT EXISTS(SELECT 1 FROM active_holds WHERE workspace_id=w AND id=p.research_hold_id AND scope_kind='firm' AND scope_key=p.firm_ref::text
  AND reason_code='scoped_pause' AND blocked_action_kinds=ARRAY['research']::text[] AND released_at IS NULL
  AND source_event_kind='calling_preparation' AND source_event_id=pid::text)
 OR NOT EXISTS(SELECT 1 FROM sourcing_candidates c JOIN sourcing_manual_prospect_states s ON s.workspace_id=c.workspace_id AND s.candidate_id=c.id
  JOIN sourcing_prospect_phone_discoveries r ON r.workspace_id=c.workspace_id AND r.candidate_id=c.id
  JOIN workspace_memberships m ON m.workspace_id=r.workspace_id AND m.user_id=p.source_creator_ref
  JOIN workspace_memberships a ON a.workspace_id=c.workspace_id AND a.user_id=p.prepared_by_ref
  WHERE c.workspace_id=w AND c.id=p.candidate_ref AND c.revision=p.candidate_revision AND c.status<>'dismissed'
  AND s.candidate_revision=c.revision AND s.state='kept' AND s.manual_phone_choice=p.choice
  AND r.id=p.discovery_run_ref AND r.candidate_revision=c.revision AND r.state='complete' AND r.content IS NOT NULL
  AND r.creator_ref=p.source_creator_ref AND r.creator_user_id=p.source_creator_ref AND r.expires_at>=p.source_expires_at
  AND m.status='active' AND m.role='admin' AND a.status='active' AND a.role='admin')
 OR EXISTS(SELECT 1 FROM dial_tickets t WHERE t.workspace_id=w AND t.calling_preparation_id=pid AND t.calling_preparation_erased_at IS NULL
  AND t.e164 IS DISTINCT FROM(SELECT e164 FROM phone_routes WHERE workspace_id=w AND id=p.route_ref))
 OR EXISTS(SELECT 1 FROM phone_handoff_attempts h WHERE h.workspace_id=w AND h.calling_preparation_id=pid AND h.erased_at IS NULL
  AND h.e164 IS DISTINCT FROM(SELECT e164 FROM phone_routes WHERE workspace_id=w AND id=p.route_ref)) THEN
  RAISE EXCEPTION 'Preparation needs exact current source, owned profile, route and research pause' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION calling_preparation_deferred_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; pid uuid;
BEGIN
 IF TG_TABLE_NAME='calling_preparations' THEN w:=NEW.workspace_id;pid:=NEW.id;
 ELSIF TG_OP='DELETE' THEN w:=OLD.workspace_id;pid:=OLD.calling_preparation_id;
 ELSE w:=NEW.workspace_id;pid:=NEW.calling_preparation_id; END IF;
 IF pid IS NOT NULL THEN PERFORM assert_calling_preparation_consistent(w,pid); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER preparation_consistency AFTER INSERT OR UPDATE ON calling_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calling_preparation_deferred_check();
CREATE CONSTRAINT TRIGGER firm_preparation_consistency AFTER INSERT OR UPDATE OR DELETE ON firms DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calling_preparation_deferred_check();
CREATE CONSTRAINT TRIGGER route_preparation_consistency AFTER INSERT OR UPDATE OR DELETE ON phone_routes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calling_preparation_deferred_check();
CREATE CONSTRAINT TRIGGER ticket_preparation_consistency AFTER INSERT OR UPDATE OR DELETE ON dial_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calling_preparation_deferred_check();
CREATE CONSTRAINT TRIGGER handoff_preparation_consistency AFTER INSERT OR UPDATE OR DELETE ON phone_handoff_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION calling_preparation_deferred_check();

CREATE FUNCTION erase_calling_preparation(w uuid,pid uuid,why text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p calling_preparations%ROWTYPE; stamp timestamptz;
BEGIN
 PERFORM require_calling_preparation_cleanup_locks(w);
 SELECT * INTO p FROM calling_preparations WHERE workspace_id=w AND id=pid FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 -- Never trust only state: terminal consistency must hold even on repeat cleanup.
 PERFORM 1 FROM firms WHERE workspace_id=w AND id=p.firm_ref FOR UPDATE;
 stamp:=clock_timestamp();
 UPDATE dial_tickets SET e164=NULL,firm_time_zone=NULL,calling_preparation_erased_at=stamp
  WHERE workspace_id=w AND calling_preparation_id=pid AND calling_preparation_erased_at IS NULL;
 UPDATE phone_handoff_attempts SET erased_at=stamp,e164=NULL,phone_route_id=NULL,route_version=NULL,contact_id=NULL,opportunity_id=NULL,
  item_id=NULL,registry_snapshot_id=NULL,registry_scrubbed_at=NULL,call_log_id=NULL,office_proof_kind=NULL,office_proof_id=NULL,office_proof_expires_at=NULL
  WHERE workspace_id=w AND calling_preparation_id=pid AND erased_at IS NULL;
 UPDATE phone_routes SET e164=NULL,calling_preparation_erased_at=stamp,eligibility='retired',retired_at=COALESCE(retired_at,stamp),
  retired_reason=COALESCE(retired_reason,'source preparation unavailable'),version=version+1,updated_at=stamp
  WHERE workspace_id=w AND id=p.route_ref AND calling_preparation_id=pid AND calling_preparation_erased_at IS NULL;
 UPDATE firms SET name='[source unavailable company]',website=NULL,address_line=NULL,locality=NULL,region_code=NULL,postal_code=NULL,country_code='ZZ',
  time_zone=NULL,time_zone_confidence=NULL,time_zone_source=NULL,time_zone_rule_version=NULL,time_zone_unresolved_reason=NULL,
  calling_preparation_erased_at=stamp,updated_at=stamp
  WHERE workspace_id=w AND id=p.firm_ref AND calling_preparation_id=pid AND calling_preparation_erased_at IS NULL;
 IF p.state='live' THEN
  UPDATE calling_preparations SET state='erased',revision=revision+1,updated_at=stamp,erased_at=stamp,erase_reason=why,
   choice=NULL,source_url_hashes=NULL,profile_hash=NULL WHERE workspace_id=w AND id=pid;
 END IF;
 PERFORM assert_calling_preparation_consistent(w,pid);
END $$;
CREATE FUNCTION erase_calling_preparations_for_candidate(w uuid,c uuid,why text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
 FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND candidate_ref=c AND state='live' ORDER BY id LOOP
  PERFORM erase_calling_preparation(w,pid,why);
 END LOOP;
END $$;
CREATE FUNCTION calling_preparation_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NOT(OLD.role='admin' AND OLD.status='active' AND(NEW.role<>'admin' OR NEW.status<>'active')) THEN RETURN NEW; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM calling_preparations WHERE workspace_id=OLD.workspace_id AND state='live'
  AND(OLD.user_id=source_creator_ref OR OLD.user_id=prepared_by_ref)) THEN
  -- Inspection/refusal only: NEVER acquire lifecycle/gate under the member row.
  PERFORM require_calling_preparation_cleanup_locks(OLD.workspace_id);
  FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=OLD.workspace_id AND state='live'
   AND(OLD.user_id=source_creator_ref OR OLD.user_id=prepared_by_ref) ORDER BY id LOOP
   PERFORM erase_calling_preparation(OLD.workspace_id,pid,'creator_inactive');
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_member_guard BEFORE UPDATE OF role,status OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION calling_preparation_member_guard();
CREATE FUNCTION calling_preparation_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM calling_preparations WHERE workspace_id=OLD.workspace_id AND research_hold_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preparation research pause is permanent' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.scope_kind,NEW.scope_key,NEW.reason_code,NEW.blocked_action_kinds,NEW.source_event_kind,NEW.source_event_id,NEW.released_at)
   IS DISTINCT FROM ROW(OLD.scope_kind,OLD.scope_key,OLD.reason_code,OLD.blocked_action_kinds,OLD.source_event_kind,OLD.source_event_id,OLD.released_at) THEN
   RAISE EXCEPTION 'Preparation research pause cannot release or rebind' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_hold_guard BEFORE UPDATE OR DELETE ON active_holds FOR EACH ROW EXECUTE FUNCTION calling_preparation_hold_guard();

CREATE FUNCTION calling_preparation_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; c uuid; pid uuid; hash text; source_url text; why text:='source_changed'; shorter timestamptz;
BEGIN
 IF TG_OP='INSERT' THEN w:=NEW.workspace_id; ELSE w:=OLD.workspace_id; END IF;
 IF TG_TABLE_NAME='sourcing_candidates' THEN
  c:=OLD.id;
  IF TG_OP='DELETE' THEN why:='source_deleted';
  ELSIF ROW(NEW.revision,NEW.payload,NEW.status,NEW.qualification_blocked) IS DISTINCT FROM ROW(OLD.revision,OLD.payload,OLD.status,OLD.qualification_blocked) THEN why:='candidate_changed';
  ELSIF NOT COALESCE(NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN('source_unavailable','source_not_permitted','no_readable_text'),false) THEN RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND COALESCE(NEW.source_check->>'state'='unavailable' AND NEW.source_check->>'reason' IN('source_unavailable','source_not_permitted','no_readable_text'),false) THEN
   FOR source_url IN SELECT url FROM unnest(ARRAY[NEW.payload->>'sourceUrl',NEW.source_check->'lastSuccess'->>'url']||
    ARRAY(SELECT source->>'sourceUrl' FROM sourcing_candidate_discovery_origins WHERE workspace_id=w AND candidate_id=c)) url WHERE url IS NOT NULL LOOP
    FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND state='live'
     AND encode(sha256(convert_to(rtrim(source_url,'/'),'UTF8')),'hex')=ANY(source_url_hashes) ORDER BY id LOOP
     PERFORM erase_calling_preparation(w,pid,'source_changed');
    END LOOP;
   END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='sourcing_manual_prospect_states' THEN
  c:=OLD.candidate_id;why:='choice_withdrawn';
  IF TG_OP='UPDATE' THEN
   IF ROW(NEW.candidate_revision,NEW.state,NEW.manual_phone_choice) IS NOT DISTINCT FROM ROW(OLD.candidate_revision,OLD.state,OLD.manual_phone_choice) THEN RETURN NEW; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='sourcing_candidate_discovery_origins' THEN c:=OLD.candidate_id;
 ELSIF TG_TABLE_NAME='sourcing_prospect_phone_discoveries' THEN
  IF TG_OP='DELETE' THEN
   FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND discovery_run_ref=OLD.id AND state='live' ORDER BY id LOOP
    PERFORM erase_calling_preparation(w,pid,'source_deleted');
   END LOOP;
  ELSIF NEW.content IS NULL OR NEW.state='unavailable' OR NEW.creator_ref IS NULL
   OR ROW(NEW.content,NEW.creator_ref,NEW.creator_user_id,NEW.candidate_id,NEW.candidate_revision)
    IS DISTINCT FROM ROW(OLD.content,OLD.creator_ref,OLD.creator_user_id,OLD.candidate_id,OLD.candidate_revision) THEN
   -- Only the bound run can withdraw its preparation; an unrelated older run
   -- must not erase a newer exact retained choice.
   FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND discovery_run_ref=OLD.id AND state='live' ORDER BY id LOOP
    PERFORM erase_calling_preparation(w,pid,why);
   END LOOP;
  ELSIF NEW.expires_at<OLD.expires_at THEN
   IF NEW.expires_at<=clock_timestamp() THEN c:=OLD.candidate_id;why:='source_expired'; ELSE shorter:=NEW.expires_at; END IF;
  ELSE RETURN NEW; END IF;
  IF shorter IS NOT NULL THEN
   FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND discovery_run_ref=OLD.id AND state='live' AND source_expires_at>shorter ORDER BY id LOOP
    PERFORM require_calling_preparation_cleanup_locks(w);
    UPDATE calling_preparations SET source_expires_at=shorter,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=w AND id=pid;
   END LOOP;
  END IF;
 ELSIF TG_TABLE_NAME='audit_events' THEN
  IF NEW.action<>'sourcing.manual_source_retention_expired' OR NEW.subject_kind<>'sourcing_source_hash' THEN RETURN NEW; END IF;
  hash:=NEW.subject_id;why:='source_expired';
 ELSIF TG_TABLE_NAME='evidence_items' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.retention_expires_at<=clock_timestamp() OR(NOT NEW.terms_allow_retention AND NEW.retention_expires_at IS NULL) THEN why:='source_not_permitted';
   ELSIF NEW.retention_expires_at IS NOT NULL THEN shorter:=NEW.retention_expires_at; ELSE RETURN NEW; END IF;
   hash:=encode(sha256(convert_to(rtrim(NEW.source_reference,'/'),'UTF8')),'hex');
  ELSE
   hash:=encode(sha256(convert_to(rtrim(OLD.source_reference,'/'),'UTF8')),'hex');
   IF TG_OP='DELETE' THEN why:='source_deleted';
   ELSIF ROW(NEW.source_reference,NEW.content_hash,NEW.retrieved_at) IS DISTINCT FROM ROW(OLD.source_reference,OLD.content_hash,OLD.retrieved_at)
    OR NEW.retention_expires_at<=clock_timestamp() OR(NOT NEW.terms_allow_retention AND NEW.retention_expires_at IS NULL) THEN why:='source_changed';
   ELSIF NEW.retention_expires_at IS NOT NULL AND(OLD.retention_expires_at IS NULL OR NEW.retention_expires_at<OLD.retention_expires_at) THEN shorter:=NEW.retention_expires_at;
   ELSE RETURN NEW; END IF;
  END IF;
 END IF;
 IF c IS NOT NULL THEN PERFORM erase_calling_preparations_for_candidate(w,c,why); END IF;
 IF hash IS NOT NULL THEN
  FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=w AND state='live' AND hash=ANY(source_url_hashes) ORDER BY id LOOP
   IF shorter IS NULL THEN PERFORM erase_calling_preparation(w,pid,why);
   ELSE
    PERFORM require_calling_preparation_cleanup_locks(w);
    UPDATE calling_preparations SET source_expires_at=LEAST(source_expires_at,shorter),revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=w AND id=pid AND source_expires_at>shorter;
   END IF;
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_candidate_source BEFORE UPDATE OF revision,payload,status,source_check,qualification_blocked OR DELETE ON sourcing_candidates FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_choice_source BEFORE UPDATE OR DELETE ON sourcing_manual_prospect_states FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_origin_source BEFORE UPDATE OR DELETE ON sourcing_candidate_discovery_origins FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_run_source BEFORE UPDATE OR DELETE ON sourcing_prospect_phone_discoveries FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_evidence_source BEFORE UPDATE OR DELETE ON evidence_items FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_evidence_denial AFTER INSERT ON evidence_items FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();
CREATE TRIGGER calling_preparation_audit_source BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_guard();

REVOKE ALL ON calling_preparations FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON calling_preparations TO app_runtime,migration;
REVOKE ALL ON FUNCTION calling_preparation_profile_hash(uuid,uuid),calling_preparation_lock_held(text,text),require_calling_preparation_cleanup_locks(uuid),
 calling_preparation_identity_guard(),calling_preparation_copy_guard(),calling_preparation_alias_guard(),assert_calling_preparation_consistent(uuid,uuid),calling_preparation_deferred_check(),
 erase_calling_preparation(uuid,uuid,text),erase_calling_preparations_for_candidate(uuid,uuid,text),calling_preparation_member_guard(),calling_preparation_hold_guard(),calling_preparation_source_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calling_preparation_profile_hash(uuid,uuid),calling_preparation_lock_held(text,text),require_calling_preparation_cleanup_locks(uuid),
 assert_calling_preparation_consistent(uuid,uuid),erase_calling_preparation(uuid,uuid,text),erase_calling_preparations_for_candidate(uuid,uuid,text) TO app_runtime,migration;
