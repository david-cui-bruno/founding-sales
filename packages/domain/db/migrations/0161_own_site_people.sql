-- changes: outreach_people_contacts
-- LOCAL schema 161 (ADR0037). The company's OWN published pages are a free source of the named decision-maker (provider 'own_site', zero credits), so a found
-- person may now (a) have no address ('unavailable': named, shown to Calling, never emailed), (b) carry an address the company's own page published
-- ('published') beside the provider-verified one, and (c) cite the page, block and words it was read from. Additive and widening only: three nullable
-- columns, one dropped NOT NULL and the 0160 person CHECK replaced by a superset (every row 0160 admits still satisfies it). The 0160 lineage trigger is
-- unchanged: it joins the person's address to the route, so a person with no address can never be admitted.
ALTER TABLE outreach_people_contacts
 ALTER COLUMN email DROP NOT NULL,
 ADD COLUMN source_url text,
 ADD COLUMN source_block_id text,
 ADD COLUMN source_quote text;
ALTER TABLE outreach_people_contacts DROP CONSTRAINT outreach_people_contacts_found,
 ADD CONSTRAINT outreach_people_contacts_found CHECK(
  length(provider_person_id) BETWEEN 1 AND 64 AND length(first_name) BETWEEN 1 AND 100 AND length(last_name) BETWEEN 1 AND 100 AND length(title) BETWEEN 1 AND 200
  AND match_confidence IN ('high','medium')
  AND (email IS NULL OR (email=lower(email) AND split_part(email,'@',2)=host AND position('@' IN email)>1))
  AND ((email_status='verified' AND email IS NOT NULL) OR (email_status='published' AND email IS NOT NULL AND source_url IS NOT NULL) OR (email_status='unavailable' AND email IS NULL))),
 ADD CONSTRAINT outreach_people_contacts_source CHECK(
  (source_url IS NULL)=(source_block_id IS NULL) AND (source_url IS NULL)=(source_quote IS NULL)
  AND (source_url IS NULL OR (length(source_url) BETWEEN 1 AND 2048 AND length(source_block_id) BETWEEN 1 AND 64 AND length(source_quote) BETWEEN 1 AND 600)));
