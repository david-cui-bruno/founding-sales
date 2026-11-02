-- changes: outreach_email_campaign_admissions
-- LOCAL schema 158 (ADR0035). A prepared own-site company may be admitted into an approved campaign after its one published address
-- has a recorded free in-house check (syntax, a real MX record, no consumer or disposable domain). Widening only: one CHECK gains a source kind, one trigger and one append-only table are new.
-- No row is rewritten and no sending switch changes.
CREATE TABLE outreach_email_verifications (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 -- sha256 of the lowercase address. The address itself is already held by its route; this is a lookup key, not a second copy.
 address_key text NOT NULL CONSTRAINT email_verification_key CHECK(address_key ~ '^[a-f0-9]{64}$'),
 provider text NOT NULL CONSTRAINT email_verification_provider CHECK(provider='dns_mx'),
 result text NOT NULL CONSTRAINT email_verification_result CHECK(result IN ('valid','invalid')),
 -- valid admits; invalid drops. A resolver error records nothing and is asked again later.
 outcome text NOT NULL CONSTRAINT email_verification_outcome CHECK((result='valid' AND outcome='ok') OR (result='invalid' AND outcome='drop')),
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT email_verification_pkey PRIMARY KEY(workspace_id,id)
);
CREATE INDEX email_verification_lookup ON outreach_email_verifications(workspace_id,address_key,checked_at DESC);
GRANT SELECT,INSERT ON outreach_email_verifications TO app_runtime,migration;
ALTER TABLE outreach_email_campaign_admissions
 DROP CONSTRAINT email_campaign_admission_source,
 ADD CONSTRAINT email_campaign_admission_source CHECK(
  (source_kind='discovery_research' AND publication_id IS NULL AND publication_revision IS NULL AND candidate_revision IS NULL AND evidence_fingerprint IS NULL)
  OR (source_kind='automatic_research' AND publication_id IS NOT NULL AND publication_revision IS NOT NULL AND publication_revision>0 AND candidate_revision IS NOT NULL AND candidate_revision>0 AND evidence_fingerprint IS NOT NULL AND evidence_fingerprint ~ '^[a-f0-9]{64}$')
  OR (source_kind='prepared_capture' AND publication_id IS NULL AND publication_revision IS NULL AND candidate_revision IS NOT NULL AND candidate_revision>0 AND evidence_fingerprint IS NULL)
 );
-- Fail closed in the database as well: a prepared admission names the exact run and revision, and its route's address has a valid
-- check made within the last seven days. The generic lineage trigger of 0130 still proves source, route, plan and enrollment.
CREATE FUNCTION outreach_email_campaign_prepared_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_kind='prepared_capture' AND NOT EXISTS(
  SELECT 1 FROM email_addresses r
  JOIN sourcing_qualification_runs q ON q.workspace_id=r.workspace_id AND q.id=NEW.qualification_run_id AND q.candidate_id=NEW.candidate_id AND q.candidate_revision=NEW.candidate_revision
  JOIN outreach_email_verifications v ON v.workspace_id=r.workspace_id AND v.address_key=encode(sha256(convert_to(lower(r.address),'UTF8')),'hex') AND v.outcome='ok' AND v.checked_at>clock_timestamp()-interval '7 days'
  WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.route_id AND r.firm_id=NEW.firm_id
 ) THEN RAISE EXCEPTION 'Invalid prepared campaign source lineage' USING ERRCODE='23514',CONSTRAINT='email_campaign_prepared_lineage'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_prepared_lineage BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_prepared_lineage();
