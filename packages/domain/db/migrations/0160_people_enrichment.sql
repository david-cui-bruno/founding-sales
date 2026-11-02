-- changes: outreach_people_lookups, outreach_people_contacts, workspace_settings, outreach_email_campaign_admissions
-- LOCAL schema 160 (ADR0036). A campaign email goes to a NAMED decision-maker with a provider-verified personal address, never a role
-- mailbox. Additive: two new tables (the per-company provider spend custody, and the provider person's copy), one widened settings CHECK
-- and a second prepared-lineage trigger so a prepared admission now also proves "a current found provider person for this candidate, with
-- this address and this name". No stored row is rewritten, no routine is replaced and no sending switch changes.
--
-- (a) Spend custody: one row per (candidate, provider) AND per (host, provider), inserted and committed BEFORE the paid call (state
--     'reserved', credits = the most the call can cost), so a company is never paid for twice, whatever happens next. It holds NO personal
--     data (only state, a refusal reason, credits and dates) and has NO foreign key to the candidate: candidate, contact and Firm erasure
--     never delete it, so neither the host fence nor the daily-cap ledger can be erased into a second payment.
CREATE TABLE outreach_people_lookups (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 -- Documentary opaque id: deliberately no FK or cascade (see above).
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL,
 host text NOT NULL,
 provider text NOT NULL,
 state text NOT NULL,
 reason text,
 credits smallint NOT NULL,
 business_date date NOT NULL,
 business_time_zone text NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 observed_at timestamptz,
 expires_at timestamptz NOT NULL,
 CONSTRAINT outreach_people_lookups_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT outreach_people_lookups_candidate_provider_key UNIQUE(workspace_id,candidate_id,provider),
 CONSTRAINT outreach_people_lookups_host_provider_key UNIQUE(workspace_id,host,provider),
 CONSTRAINT outreach_people_lookups_revision CHECK(candidate_revision>0),
 CONSTRAINT outreach_people_lookups_host CHECK(length(host) BETWEEN 1 AND 253 AND host=lower(host)),
 CONSTRAINT outreach_people_lookups_provider CHECK(provider ~ '^[a-z][a-z0-9_]{1,31}$'),
 CONSTRAINT outreach_people_lookups_state CHECK(state IN ('reserved','found','none','failed','unknown')),
 CONSTRAINT outreach_people_lookups_reason CHECK(reason IS NULL OR reason IN ('no_person','unverified','low_confidence','no_name','title','invalid_email','role_address','consumer_domain','domain_mismatch','auth_failed','quota_exhausted','rate_limited','unavailable','invalid_response')),
 CONSTRAINT outreach_people_lookups_credits CHECK(credits BETWEEN 0 AND 9),
 CONSTRAINT outreach_people_lookups_zone CHECK(length(business_time_zone) BETWEEN 1 AND 64),
 CONSTRAINT outreach_people_lookups_expiry CHECK(expires_at>reserved_at AND expires_at<=reserved_at+interval '31 days'),
 CONSTRAINT outreach_people_lookups_shape CHECK((observed_at IS NOT NULL)=(state IN ('found','none')) AND (state<>'found' OR reason IS NULL))
);
CREATE INDEX outreach_people_lookups_day ON outreach_people_lookups(workspace_id,business_date);
GRANT SELECT,INSERT,UPDATE ON outreach_people_lookups TO app_runtime,migration;
-- (a2) The provider person's copy (name, title, address, provider id) of a 'found' lookup. Candidate deletion cascades it and CRM contact/Firm
--      deletion erases it explicitly (the application may DELETE here, never UPDATE); the lookup above survives either, still 'found', so the
--      company is neither paid for again nor re-admitted. A found address is lower case, verified, at the company's own host.
CREATE TABLE outreach_people_contacts (
 workspace_id uuid NOT NULL,
 lookup_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 host text NOT NULL,
 provider_person_id text NOT NULL,
 first_name text NOT NULL,
 last_name text NOT NULL,
 title text NOT NULL,
 email text NOT NULL,
 email_status text NOT NULL,
 match_confidence text NOT NULL,
 CONSTRAINT outreach_people_contacts_pkey PRIMARY KEY(workspace_id,lookup_id),
 CONSTRAINT outreach_people_contacts_lookup_fkey FOREIGN KEY(workspace_id,lookup_id) REFERENCES outreach_people_lookups(workspace_id,id),
 CONSTRAINT outreach_people_contacts_candidate_fkey FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT outreach_people_contacts_found CHECK(
  length(provider_person_id) BETWEEN 1 AND 64 AND length(first_name) BETWEEN 1 AND 100 AND length(last_name) BETWEEN 1 AND 100 AND length(title) BETWEEN 1 AND 200
  AND email=lower(email) AND split_part(email,'@',2)=host AND position('@' IN email)>1 AND email_status='verified' AND match_confidence IN ('high','medium'))
);
CREATE INDEX outreach_people_contacts_candidate ON outreach_people_contacts(workspace_id,candidate_id);
GRANT SELECT,INSERT,DELETE ON outreach_people_contacts TO app_runtime,migration;
-- (b) `workspace_settings_key_known` admits 'people_enrichment' ({ "enabled": boolean, "dailyCredits": 0..200 }). Every key 0157 admits stays.
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known
 CHECK (setting_key IN (
 'business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents',
 'meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording','booking_policy',
 'booking_link','people_enrichment'));
-- (c) A second prepared-admission lineage trigger (0158's stays: run, revision and a valid address check). It proves the person: the route
--     belongs to the admitted contact, whose name is the found provider person's name, and that person is current (an unexpired found lookup
--     for exactly this candidate revision, whose person copy still exists) and verified with this very address. The generic lineage trigger of 0130 still proves source, route, plan and enrollment.
CREATE FUNCTION outreach_email_campaign_prepared_person_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_kind='prepared_capture' AND NOT EXISTS(
  SELECT 1 FROM email_addresses r
  JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=NEW.contact_id AND c.firm_id=r.firm_id
  JOIN outreach_people_lookups p ON p.workspace_id=r.workspace_id AND p.candidate_id=NEW.candidate_id AND p.candidate_revision=NEW.candidate_revision AND p.state='found' AND p.expires_at>clock_timestamp()
  JOIN outreach_people_contacts q ON q.workspace_id=p.workspace_id AND q.lookup_id=p.id AND q.email=lower(r.address) AND c.full_name=q.first_name||' '||q.last_name
  WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.route_id AND r.firm_id=NEW.firm_id AND r.contact_id=NEW.contact_id
 ) THEN RAISE EXCEPTION 'Invalid prepared campaign person lineage' USING ERRCODE='23514',CONSTRAINT='email_campaign_prepared_person_lineage'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_prepared_person_lineage BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_prepared_person_lineage();
