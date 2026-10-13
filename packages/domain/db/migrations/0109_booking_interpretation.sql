-- changes: crm_booking_interpretations
-- Interpretation candidates never authorize a sender or appointment provider.
CREATE TABLE crm_booking_interpretations (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 requested_by uuid NOT NULL,
 source_refs jsonb NOT NULL CONSTRAINT crm_booking_interpretations_sources CHECK(jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 4 AND octet_length(source_refs::text)<=2048),
 source_fingerprint text NOT NULL CONSTRAINT crm_booking_interpretations_fingerprint CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 provenance jsonb CONSTRAINT crm_booking_interpretations_provenance CHECK(provenance IS NULL OR (jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=65536)),
 authority_snapshot jsonb,
 state text NOT NULL CONSTRAINT crm_booking_interpretations_state CHECK(state IN ('unavailable','pending','processing','complete','stale','unknown_acceptance')),
 reason text,
 outcome jsonb CONSTRAINT crm_booking_interpretations_outcome CHECK(outcome IS NULL OR (jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=16384)),
 reservation_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,requested_by) REFERENCES workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,reservation_id) REFERENCES provider_reservations(workspace_id,id)
);
CREATE INDEX crm_booking_interpretations_sources_index ON crm_booking_interpretations USING gin(source_refs);
GRANT SELECT,INSERT,UPDATE ON crm_booking_interpretations TO app_runtime,migration;

-- Erase copied private provenance/candidates atomically with canonical source invalidation.
-- Body-free IDs and financial linkage survive so an unknown paid dispatch cannot be replayed.
CREATE FUNCTION invalidate_booking_interpretation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE crm_booking_interpretations SET state='stale',reason='source_changed',provenance=NULL,authority_snapshot=NULL,outcome=NULL
 WHERE workspace_id=OLD.workspace_id AND source_refs @> jsonb_build_array(jsonb_build_object('sourceId',OLD.source_id));
 RETURN NULL;
END $$;
CREATE TRIGGER crm_booking_interpretation_source_changed AFTER UPDATE OR DELETE ON crm_mail_sources
 FOR EACH ROW EXECUTE FUNCTION invalidate_booking_interpretation_source();
