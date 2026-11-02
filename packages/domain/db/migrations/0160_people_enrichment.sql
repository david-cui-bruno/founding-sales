-- changes: outreach_people_contacts, workspace_settings, outreach_email_campaign_admissions
-- LOCAL schema 160 (ADR0036). A campaign email goes to a NAMED decision-maker with a provider-verified personal address, never a role
-- mailbox. Additive: one new table (the per-company provider result and its credit ledger), one widened settings CHECK and a second
-- prepared-lineage trigger so a prepared admission now also proves "a current found provider person for this candidate, with this address
-- and this name". No stored row is rewritten, no routine is replaced and no sending switch changes.
--
-- (a) One row per (candidate, provider) AND per (host, provider): the row is inserted and committed BEFORE the paid call (state
--     'reserved', credits = the most the call can cost), so a company is never paid for twice, whatever happens next. Only a 'found' row
--     carries a person (name, title, address, provider id); every other state holds no personal data, only a refusal reason. A found
--     address is lower case, verified, at the company's own host.
CREATE TABLE outreach_people_contacts (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL,
 host text NOT NULL,
 provider text NOT NULL,
 state text NOT NULL,
 reason text,
 provider_person_id text,
 first_name text,
 last_name text,
 title text,
 email text,
 email_status text,
 match_confidence text,
 credits smallint NOT NULL,
 business_date date NOT NULL,
 business_time_zone text NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 observed_at timestamptz,
 expires_at timestamptz NOT NULL,
 CONSTRAINT outreach_people_contacts_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT outreach_people_contacts_candidate_provider_key UNIQUE(workspace_id,candidate_id,provider),
 CONSTRAINT outreach_people_contacts_host_provider_key UNIQUE(workspace_id,host,provider),
 CONSTRAINT outreach_people_contacts_candidate_fkey FOREIGN KEY(workspace_id,candidate_id) REFERENCES sourcing_candidates(workspace_id,id) ON DELETE CASCADE,
 CONSTRAINT outreach_people_contacts_revision CHECK(candidate_revision>0),
 CONSTRAINT outreach_people_contacts_host CHECK(length(host) BETWEEN 1 AND 253 AND host=lower(host)),
 CONSTRAINT outreach_people_contacts_provider CHECK(provider ~ '^[a-z][a-z0-9_]{1,31}$'),
 CONSTRAINT outreach_people_contacts_state CHECK(state IN ('reserved','found','none','failed','unknown')),
 CONSTRAINT outreach_people_contacts_reason CHECK(reason IS NULL OR reason IN ('no_person','unverified','low_confidence','no_name','title','invalid_email','role_address','consumer_domain','domain_mismatch','auth_failed','quota_exhausted','rate_limited','unavailable','invalid_response')),
 CONSTRAINT outreach_people_contacts_credits CHECK(credits BETWEEN 0 AND 9),
 CONSTRAINT outreach_people_contacts_zone CHECK(length(business_time_zone) BETWEEN 1 AND 64),
 CONSTRAINT outreach_people_contacts_expiry CHECK(expires_at>reserved_at AND expires_at<=reserved_at+interval '31 days'),
 CONSTRAINT outreach_people_contacts_found CHECK(
  (state='found' AND provider_person_id IS NOT NULL AND length(provider_person_id) BETWEEN 1 AND 64
   AND first_name IS NOT NULL AND length(first_name) BETWEEN 1 AND 100 AND last_name IS NOT NULL AND length(last_name) BETWEEN 1 AND 100
   AND title IS NOT NULL AND length(title) BETWEEN 1 AND 200 AND email IS NOT NULL AND email=lower(email) AND split_part(email,'@',2)=host AND position('@' IN email)>1
   AND email_status='verified' AND match_confidence IN ('high','medium') AND observed_at IS NOT NULL AND reason IS NULL)
  OR (state<>'found' AND provider_person_id IS NULL AND first_name IS NULL AND last_name IS NULL AND title IS NULL AND email IS NULL AND email_status IS NULL AND match_confidence IS NULL
   AND (observed_at IS NOT NULL)=(state='none'))
 )
);
CREATE INDEX outreach_people_contacts_day ON outreach_people_contacts(workspace_id,business_date);
GRANT SELECT,INSERT,UPDATE ON outreach_people_contacts TO app_runtime,migration;
-- (b) `workspace_settings_key_known` admits 'people_enrichment' ({ "enabled": boolean, "dailyCredits": 0..200 }). Every key 0157 admits stays.
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known
 CHECK (setting_key IN (
 'business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents',
 'meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording','booking_policy',
 'booking_link','people_enrichment'));
-- (c) A second prepared-admission lineage trigger (0158's stays: run, revision and a valid address check). It proves the person: the route
--     belongs to the admitted contact, whose name is the found provider person's name, and that person is current (unexpired, for exactly this
--     candidate revision) and verified with this very address. The generic lineage trigger of 0130 still proves source, route, plan and enrollment.
CREATE FUNCTION outreach_email_campaign_prepared_person_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_kind='prepared_capture' AND NOT EXISTS(
  SELECT 1 FROM email_addresses r
  JOIN contacts c ON c.workspace_id=r.workspace_id AND c.id=NEW.contact_id AND c.firm_id=r.firm_id
  JOIN outreach_people_contacts p ON p.workspace_id=r.workspace_id AND p.candidate_id=NEW.candidate_id AND p.candidate_revision=NEW.candidate_revision AND p.state='found'
   AND p.email=lower(r.address) AND p.expires_at>clock_timestamp() AND c.full_name=p.first_name||' '||p.last_name
  WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.route_id AND r.firm_id=NEW.firm_id AND r.contact_id=NEW.contact_id
 ) THEN RAISE EXCEPTION 'Invalid prepared campaign person lineage' USING ERRCODE='23514',CONSTRAINT='email_campaign_prepared_person_lineage'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER email_campaign_prepared_person_lineage BEFORE INSERT ON outreach_email_campaign_admissions FOR EACH ROW EXECUTE FUNCTION outreach_email_campaign_prepared_person_lineage();
