-- changes: calling_preparations
-- ADR0034/roadmap1.6.8: a preparation's phone source is a phone-discovery run (unchanged) OR a prepared own-site capture,
-- named by the qualification run, exact observation/block/hash choice and its source URL hashes. Touches-existing: adds
-- calling_preparations.source_kind (every stored row is 'phone_discovery'), replaces assert_calling_preparation_consistent
-- with the same body except its source clause, and adds immutable-kind and prepared-run loss guards. No row is rewritten,
-- no stricter rule applies to a phone-discovery preparation, and nothing here grants contact authority.
ALTER TABLE calling_preparations ADD COLUMN source_kind text NOT NULL DEFAULT 'phone_discovery';
ALTER TABLE calling_preparations ADD CONSTRAINT calling_preparations_source_kind CHECK(
 source_kind IN('phone_discovery','prepared_capture') AND(source_kind='phone_discovery' OR source_creator_ref=prepared_by_ref));
COMMENT ON COLUMN calling_preparations.discovery_run_ref IS 'Phone-discovery run id, or for source_kind=prepared_capture the qualification run id whose retained observation the choice names.';

CREATE FUNCTION calling_preparation_source_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN RAISE EXCEPTION 'Preparation source kind cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_source_kind_guard BEFORE UPDATE ON calling_preparations FOR EACH ROW EXECUTE FUNCTION calling_preparation_source_kind_guard();

CREATE OR REPLACE FUNCTION assert_calling_preparation_consistent(w uuid,pid uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  JOIN workspace_memberships m ON m.workspace_id=c.workspace_id AND m.user_id=p.source_creator_ref
  JOIN workspace_memberships a ON a.workspace_id=c.workspace_id AND a.user_id=p.prepared_by_ref
  WHERE c.workspace_id=w AND c.id=p.candidate_ref AND c.revision=p.candidate_revision AND c.status<>'dismissed'
  AND s.candidate_revision=c.revision AND s.state='kept' AND s.manual_phone_choice=p.choice
  AND m.status='active' AND m.role='admin' AND a.status='active' AND a.role='admin'
  AND CASE p.source_kind
   WHEN 'phone_discovery' THEN EXISTS(SELECT 1 FROM sourcing_prospect_phone_discoveries r WHERE r.workspace_id=c.workspace_id AND r.candidate_id=c.id
    AND r.id=p.discovery_run_ref AND r.candidate_revision=c.revision AND r.state='complete' AND r.content IS NOT NULL
    AND r.creator_ref=p.source_creator_ref AND r.creator_user_id=p.source_creator_ref AND r.expires_at>=p.source_expires_at)
   -- ADR0034: the chosen literal's exact retained observation and block, bound by hashes, in the qualification run the choice names.
   WHEN 'prepared_capture' THEN EXISTS(SELECT 1 FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id
    AND q.id=p.discovery_run_ref AND q.candidate_revision=c.revision AND q.state NOT IN('pending','running')
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q.observations)='array' THEN q.observations ELSE '[]'::jsonb END) o
     WHERE o->>'id'=p.choice->>'observationId' AND o->>'contentHash'=p.choice->>'contentHash' AND o->>'relevantTextHash'=p.choice->>'relevantTextHash'
     AND o->>'firstParty'='true' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o->'blocks')='array' THEN o->'blocks' ELSE '[]'::jsonb END) b
      WHERE b->>'id'=p.choice->>'blockId')))
   ELSE false END)
 OR EXISTS(SELECT 1 FROM dial_tickets t WHERE t.workspace_id=w AND t.calling_preparation_id=pid AND t.calling_preparation_erased_at IS NULL
  AND t.e164 IS DISTINCT FROM(SELECT e164 FROM phone_routes WHERE workspace_id=w AND id=p.route_ref))
 OR EXISTS(SELECT 1 FROM phone_handoff_attempts h WHERE h.workspace_id=w AND h.calling_preparation_id=pid AND h.erased_at IS NULL
  AND h.e164 IS DISTINCT FROM(SELECT e164 FROM phone_routes WHERE workspace_id=w AND id=p.route_ref)) THEN
  RAISE EXCEPTION 'Preparation needs exact current source, owned profile, route and research pause' USING ERRCODE='23514'; END IF;
END $$;

-- Loss of the run's retained observation or capture withdraws the preparation like loss of a discovery run. URL-hash
-- loss (evidence, source-loss audit, candidate source) already erases first through calling_preparation_source_guard;
-- this covers the run row itself. Cleanup custody is required, never acquired here.
CREATE FUNCTION calling_preparation_prepared_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
 -- A preparation binds only a finished run (assertion above), so an in-flight run's own writes, including its completion, can never find one.
 IF TG_OP='UPDATE' AND OLD.state IN('pending','running') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.candidate_id,NEW.candidate_revision,NEW.observations,NEW.prepared_capture)
  IS NOT DISTINCT FROM ROW(OLD.candidate_id,OLD.candidate_revision,OLD.observations,OLD.prepared_capture) THEN RETURN NEW; END IF;
 FOR pid IN SELECT id FROM calling_preparations WHERE workspace_id=OLD.workspace_id AND source_kind='prepared_capture'
  AND discovery_run_ref=OLD.id AND state='live' ORDER BY id LOOP
  PERFORM erase_calling_preparation(OLD.workspace_id,pid,CASE WHEN TG_OP='DELETE' THEN 'source_deleted' ELSE 'source_changed' END);
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calling_preparation_prepared_run_source BEFORE UPDATE OF candidate_id,candidate_revision,observations,prepared_capture OR DELETE ON sourcing_qualification_runs
 FOR EACH ROW EXECUTE FUNCTION calling_preparation_prepared_run_guard();
REVOKE ALL ON FUNCTION calling_preparation_source_kind_guard(),calling_preparation_prepared_run_guard() FROM PUBLIC;
