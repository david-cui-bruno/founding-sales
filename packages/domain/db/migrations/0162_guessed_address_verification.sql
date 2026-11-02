-- changes: outreach_people_lookups, outreach_people_contacts, outreach_email_verifications
-- LOCAL schema 162 (ADR0038). A named person the company's own pages published WITHOUT an address may be given ONE guessed address, `first@host`, kept only when a
-- paid single-address check (MillionVerifier, provider 'millionverifier') answers `ok`; a published address is checked once before admission. Three widenings, nothing rewritten, no routine replaced:
--  (a) an own-site person's copy may now hold status 'verified_guess': an address the company did NOT publish, verified deliverable by the check, still citing the page the NAME
--      was read from (so the proof's cited-page and deadline rules apply unchanged). The 0160 lineage trigger is untouched: it joins the person's address to the route.
--  (b) the spend custody's refusal reasons gain the verifier's five answers and a free no-mail-domain refusal, so a guess or a check is recorded in custody (one row per
--      candidate and per host for provider 'millionverifier', beside the 'own_site' row) and is never paid for again until it expires. 'interrupted' is what the stale-reservation sweep records for a request that never settled
--      (a crash or a rolled-back write), so it can be told from a call's own failure (`unavailable`), which leaves a published address to the free check.
--  (c) the address check record may name the paid verifier as its provider, so a published address a check found invalid is dropped by the same mechanism as a DNS refusal.
ALTER TABLE outreach_people_lookups DROP CONSTRAINT outreach_people_lookups_reason,
 ADD CONSTRAINT outreach_people_lookups_reason CHECK(reason IS NULL OR reason IN ('no_person','unverified','low_confidence','no_name','title','invalid_email','role_address','consumer_domain','domain_mismatch','auth_failed','quota_exhausted','rate_limited','unavailable','invalid_response',
  'verdict_ok','verdict_catch_all','verdict_unknown','verdict_invalid','verdict_disposable','no_mail_domain','interrupted'));
ALTER TABLE outreach_people_contacts DROP CONSTRAINT outreach_people_contacts_found,
 ADD CONSTRAINT outreach_people_contacts_found CHECK(
  length(provider_person_id) BETWEEN 1 AND 64 AND length(first_name) BETWEEN 1 AND 100 AND length(last_name) BETWEEN 1 AND 100 AND length(title) BETWEEN 1 AND 200
  AND match_confidence IN ('high','medium')
  AND (email IS NULL OR (email=lower(email) AND split_part(email,'@',2)=host AND position('@' IN email)>1))
  AND ((email_status='verified' AND email IS NOT NULL) OR (email_status IN ('published','verified_guess') AND email IS NOT NULL AND source_url IS NOT NULL) OR (email_status='unavailable' AND email IS NULL)));
ALTER TABLE outreach_email_verifications DROP CONSTRAINT email_verification_provider,
 ADD CONSTRAINT email_verification_provider CHECK(provider IN ('dns_mx','millionverifier'));
--  (d) a paid row is never renewed: its credits and business date are the spend ledger the daily cap sums, so a new candidate revision gets a NEW row beside the old one. The two 0160
--      one-row-per-candidate and per-host fences keep their names and still bind every other provider (own_site rows are free and are renewed in place); for 'millionverifier' the fence
--      is one row per candidate REVISION, so a concurrent or later second paid check for the same revision is refused by the database and an earlier revision's charge stays counted.
ALTER TABLE outreach_people_lookups DROP CONSTRAINT outreach_people_lookups_candidate_provider_key, DROP CONSTRAINT outreach_people_lookups_host_provider_key;
CREATE UNIQUE INDEX outreach_people_lookups_candidate_provider_key ON outreach_people_lookups(workspace_id,candidate_id,provider) WHERE provider<>'millionverifier';
CREATE UNIQUE INDEX outreach_people_lookups_host_provider_key ON outreach_people_lookups(workspace_id,host,provider) WHERE provider<>'millionverifier';
CREATE UNIQUE INDEX outreach_people_lookups_paid_revision_key ON outreach_people_lookups(workspace_id,candidate_id,candidate_revision) WHERE provider='millionverifier';
