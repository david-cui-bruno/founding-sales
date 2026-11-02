-- changes: workspace_settings, outreach_email_campaigns
-- Outbound email campaign step 3 (approved Nov 1 2026). Both changes only widen: every stored
-- setting row and every stored campaign row (regions drawn from TX/RI/MA) still satisfies the new
-- CHECKs, nothing is rewritten, and the immutable-campaign trigger and every other campaign
-- constraint are untouched. Sending authority is unchanged.
--
-- (a) `workspace_settings_key_known` admits 'booking_link' ({ "url": https URL | null }), the
--     admin-set booking link the `{booking_link}` template variable fills from. Every key the
--     current definition (0110) admits stays.
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known
 CHECK (setting_key IN (
 'business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents',
 'meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording','booking_policy',
 'booking_link'));
-- (b) A campaign may approve any of the 50 states and DC (US_BUSINESS_REGIONS in
--     packages/contracts/src/usBusinessGeography.ts; a test holds the two lists identical):
--     one to 51 distinct, non-null postal codes. A CHECK cannot hold a subquery, so the
--     distinctness count lives in a small IMMUTABLE function over its argument alone.
CREATE FUNCTION email_campaign_regions_valid(r text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT cardinality(r) BETWEEN 1 AND 51 AND array_position(r,NULL) IS NULL
  AND r <@ ARRAY['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']::text[]
  AND cardinality(r)=(SELECT count(DISTINCT v) FROM unnest(r) v)
$$;
ALTER TABLE outreach_email_campaigns DROP CONSTRAINT email_campaign_regions,
 ADD CONSTRAINT email_campaign_regions CHECK(email_campaign_regions_valid(regions));
-- (c) The composed footer is now sign-off, company line, stop sentence (`composeSendBody`), so the
--     opening-fence footer rebuild of 0140 follows it. Recognised blocks per recorded address are
--     today's shape and the previous one (sign-off, address) already frozen on fences. The two
--     constants equal FOOTER_COMPANY_NAME (templateFooter.ts) and SENDING_STOP_LINE (contracts).
CREATE OR REPLACE FUNCTION campaign_opening_footer_body(w uuid,t uuid,b text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE signoff text; current_address text; block text; head text; current_footer text;
 company constant text := 'Callie, AI maintenance coordination';
 stop constant text := 'If this isn''t relevant, just reply and I won''t email again.';
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(w::text||':postal_address',0));
 SELECT btrim(footer_sign_off,E' \t\n\r') INTO signoff FROM template_versions WHERE workspace_id=w AND id=t FOR SHARE;
 IF signoff IS NULL OR signoff='' THEN RETURN NULL; END IF;
 SELECT nullif(btrim(value->>'address',E' \t\n\r'),'') INTO current_address FROM workspace_settings
  WHERE workspace_id=w AND setting_key='postal_address' AND superseded_at IS NULL;
 current_footer:=signoff||E'\n'||company||CASE WHEN current_address IS NULL THEN '' ELSE ' '||chr(183)||' '||current_address END||E'\n'||stop;
 FOR block IN SELECT s FROM (WITH addresses AS (
   SELECT '' AS address UNION SELECT coalesce(current_address,'') UNION
   SELECT coalesce(nullif(btrim(v.value->>'address',E' \t\n\r'),''),'') FROM
    (SELECT value FROM workspace_settings WHERE workspace_id=w AND setting_key='postal_address' ORDER BY version DESC LIMIT 100) v
  ) SELECT signoff||E'\n'||company||CASE WHEN a.address='' THEN '' ELSE ' '||chr(183)||' '||a.address END||E'\n'||stop AS s FROM addresses a
    UNION
    SELECT signoff||CASE WHEN a.address='' THEN '' ELSE E'\n'||a.address END FROM addresses a) x ORDER BY length(s) DESC LOOP
  IF b=block THEN RETURN current_footer; END IF;
  IF right(b,length(block)+2)=E'\n\n'||block THEN
   head:=left(b,length(b)-length(block)-2);
   RETURN head||E'\n\n'||current_footer;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
