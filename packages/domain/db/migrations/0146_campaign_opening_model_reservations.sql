-- changes: provider_reservations
-- Price the new public-identity approved-opening selector in the existing conserved
-- model ledger. No campaign, setting, enrollment, source or sending changes.
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN (
 'research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis',
 'meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft',
 'crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support','booking_interpretation','campaign_opening'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support','booking_interpretation','campaign_opening') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
ALTER TABLE provider_reservations ADD CONSTRAINT campaign_opening_model_reservation_shape CHECK (
 (subject_kind <> 'campaign_opening' OR (provider_key='aws_bedrock.campaign_opening'
 AND model_name='claude-haiku-4-5' AND max_input_tokens BETWEEN 1 AND 10000 AND max_output_tokens=256)) IS TRUE);
