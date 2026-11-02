-- changes: outreach_people_paid_checks, outreach_people_contacts, outreach_email_verifications
-- LOCAL schema 162 (ADR0038). A named person the company's own pages published WITHOUT an address may be given ONE guessed address, `first@host`, kept only when a
-- paid single-address check (MillionVerifier) answers `ok`; a published address is checked once before admission. One new table and two widened CHECKs (each dropped and re-added under its
-- own name); nothing is rewritten, no routine is replaced, no grant on an existing table changes, and the 0160 spend custody `outreach_people_lookups` and its two unique fences are untouched.
--  (a) `outreach_people_paid_checks` is the APPEND-ONLY spend ledger of paid address checks, one row per candidate REVISION. Charged or possibly charged rows are never renewed:
--      a changed revision adds a row, preserving every earlier charge in the daily cap sum. Only an explicitly uncharged refusal can reuse its row after its cooldown.
--      Like legacy custody, it holds no personal data (no address, no name) and has NO foreign key to the candidate: candidate, contact and Firm erasure never delete it, so neither the fence nor the
--      cap ledger can be erased into a second payment. The application may add, read and update it, never delete. The company fence (an unresolved or negative attempt holds the company by
--      candidate OR host) is enforced by the reservation under the workspace advisory lock; the one-row-per-revision fence is the database's.
CREATE TABLE outreach_people_paid_checks (
 workspace_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 -- Documentary opaque id: deliberately no FK or cascade (see above).
 candidate_id uuid NOT NULL,
 candidate_revision integer NOT NULL,
 host text NOT NULL,
 kind text NOT NULL,
 state text NOT NULL,
 reason text,
 credits smallint NOT NULL,
 business_date date NOT NULL,
 business_time_zone text NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 observed_at timestamptz,
 expires_at timestamptz NOT NULL,
 CONSTRAINT outreach_people_paid_checks_pkey PRIMARY KEY(workspace_id,id),
 CONSTRAINT outreach_people_paid_checks_revision_key UNIQUE(workspace_id,candidate_id,candidate_revision),
 CONSTRAINT outreach_people_paid_checks_revision CHECK(candidate_revision>0),
 CONSTRAINT outreach_people_paid_checks_host CHECK(length(host) BETWEEN 1 AND 253 AND host=lower(host)),
 CONSTRAINT outreach_people_paid_checks_kind CHECK(kind IN ('guess','published')),
 CONSTRAINT outreach_people_paid_checks_state CHECK(state IN ('reserved','none','failed','unknown')),
 CONSTRAINT outreach_people_paid_checks_reason CHECK(reason IS NULL OR reason IN ('verdict_ok','verdict_catch_all','verdict_unknown','verdict_invalid','verdict_disposable','no_mail_domain','auth_failed','quota_exhausted','rate_limited','unavailable','invalid_response','interrupted')),
 CONSTRAINT outreach_people_paid_checks_credits CHECK(credits BETWEEN 0 AND 1),
 CONSTRAINT outreach_people_paid_checks_zone CHECK(length(business_time_zone) BETWEEN 1 AND 64),
 CONSTRAINT outreach_people_paid_checks_expiry CHECK(expires_at>reserved_at AND expires_at<=reserved_at+interval '31 days'),
 CONSTRAINT outreach_people_paid_checks_shape CHECK((observed_at IS NOT NULL)=(state='none') AND (state='reserved')=(reason IS NULL))
);
CREATE INDEX outreach_people_paid_checks_day ON outreach_people_paid_checks(workspace_id,business_date);
CREATE INDEX outreach_people_paid_checks_host ON outreach_people_paid_checks(workspace_id,host);
GRANT SELECT,INSERT,UPDATE ON outreach_people_paid_checks TO app_runtime,migration;
--  (b) an own-site person's copy may now hold status 'verified_guess': an address the company did NOT publish, verified deliverable by the check, still citing the page the NAME
--      was read from (so the proof's cited-page and deadline rules apply unchanged). It hangs off a free 0160 custody row (provider 'millionverifier', 0 credits, read again in
--      place like 'own_site'); the 0160 lineage trigger is untouched: it joins the person's address to the route.
ALTER TABLE outreach_people_contacts DROP CONSTRAINT outreach_people_contacts_found,
 ADD CONSTRAINT outreach_people_contacts_found CHECK(
  length(provider_person_id) BETWEEN 1 AND 64 AND length(first_name) BETWEEN 1 AND 100 AND length(last_name) BETWEEN 1 AND 100 AND length(title) BETWEEN 1 AND 200
  AND match_confidence IN ('high','medium')
  AND (email IS NULL OR (email=lower(email) AND split_part(email,'@',2)=host AND position('@' IN email)>1))
  AND ((email_status='verified' AND email IS NOT NULL) OR (email_status IN ('published','verified_guess') AND email IS NOT NULL AND source_url IS NOT NULL) OR (email_status='unavailable' AND email IS NULL)));
--  (c) the address check record may name the paid verifier as its provider, so a published address a check found invalid is dropped by the same mechanism as a DNS refusal.
ALTER TABLE outreach_email_verifications DROP CONSTRAINT email_verification_provider,
 ADD CONSTRAINT email_verification_provider CHECK(provider IN ('dns_mx','millionverifier'));
