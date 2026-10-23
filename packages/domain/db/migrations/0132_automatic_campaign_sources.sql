-- changes: outreach_email_campaign_admissions
-- LOCAL only. Opaque immutable history survives private source deletion and keeps caps.
ALTER TABLE outreach_email_campaign_admissions
 ADD COLUMN source_kind text NOT NULL DEFAULT 'discovery_research',
 ADD COLUMN publication_id uuid,
 ADD COLUMN publication_revision integer,
 ADD COLUMN candidate_revision integer,
 ADD COLUMN evidence_fingerprint text,
 ADD CONSTRAINT email_campaign_admission_source CHECK(
  (source_kind='discovery_research' AND publication_id IS NULL AND publication_revision IS NULL AND candidate_revision IS NULL AND evidence_fingerprint IS NULL)
  OR (source_kind='automatic_research' AND publication_id IS NOT NULL AND publication_revision IS NOT NULL AND publication_revision>0 AND candidate_revision IS NOT NULL AND candidate_revision>0 AND evidence_fingerprint IS NOT NULL AND evidence_fingerprint ~ '^[a-f0-9]{64}$')
 );
-- No FK to publication/candidate/run/source. These IDs are cap history, not private custody.
CREATE FUNCTION outreach_email_campaign_source_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_kind='automatic_research' AND NOT EXISTS(
  SELECT 1 FROM sourcing_automatic_research_firms p
  JOIN outreach_email_campaigns c ON c.workspace_id=p.workspace_id AND c.id=NEW.campaign_id AND c.owner_user_id=p.owner_user_id
  JOIN firms f ON f.workspace_id=p.workspace_id AND f.id=p.firm_id AND f.assigned_user_id=p.owner_user_id AND f.status='active'
  JOIN sourcing_candidates candidate ON candidate.workspace_id=p.workspace_id AND candidate.id=p.candidate_id AND candidate.revision=p.candidate_revision AND NOT candidate.qualification_blocked AND candidate.status<>'dismissed'
  JOIN sourcing_qualification_runs r ON r.workspace_id=p.workspace_id AND r.id=p.run_id AND r.candidate_id=p.candidate_id AND r.candidate_revision=p.candidate_revision
  WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.publication_id AND p.revision=NEW.publication_revision AND p.firm_id=NEW.firm_id AND p.candidate_id=NEW.candidate_id AND p.run_id=NEW.qualification_run_id AND p.candidate_revision=NEW.candidate_revision AND p.evidence_fingerprint=NEW.evidence_fingerprint
 ) THEN RAISE EXCEPTION 'Invalid automatic campaign source lineage' USING ERRCODE='23514',CONSTRAINT='email_campaign_automatic_lineage'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_automatic_lineage BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_source_lineage();
CREATE FUNCTION outreach_email_campaign_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.source_kind,NEW.publication_id,NEW.publication_revision,NEW.candidate_revision,NEW.evidence_fingerprint,NEW.candidate_id,NEW.qualification_run_id,NEW.campaign_id,NEW.admitted_at)
 IS DISTINCT FROM ROW(OLD.source_kind,OLD.publication_id,OLD.publication_revision,OLD.candidate_revision,OLD.evidence_fingerprint,OLD.candidate_id,OLD.qualification_run_id,OLD.campaign_id,OLD.admitted_at)
 THEN RAISE EXCEPTION 'Immutable campaign source history' USING ERRCODE='23514',CONSTRAINT='email_campaign_source_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_source_immutable BEFORE UPDATE ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_source_immutable();
