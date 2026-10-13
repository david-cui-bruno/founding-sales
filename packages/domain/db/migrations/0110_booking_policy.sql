-- changes: workspace_settings, provider_reservations
-- Reuse immutable administrative setting versions and the existing conserved money ledger.
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known
 CHECK (setting_key IN (
 'business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents',
 'meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording','booking_policy'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN (
 'research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis',
 'meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft',
 'crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support','booking_interpretation'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_priced_shape,
 ADD CONSTRAINT provider_reservations_priced_shape CHECK (
 (subject_kind NOT IN ('research_run','reply_classification','call_summary','call_analysis','meeting_analysis','sourcing_qualification','outreach_reply','social_draft','crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support','booking_interpretation') OR
 (model_name IS NOT NULL AND max_input_tokens IS NOT NULL AND max_output_tokens IS NOT NULL AND priced_unit IS NULL AND max_units IS NULL AND unit_price_micros IS NULL))
 AND (subject_kind NOT IN ('call_session','call_transcription','meeting_transcription') OR
 (model_name IS NULL AND max_input_tokens IS NULL AND max_output_tokens IS NULL AND priced_unit='minute' AND priced_unit IS NOT NULL AND max_units IS NOT NULL AND max_units BETWEEN 1 AND 240 AND unit_price_micros IS NOT NULL AND unit_price_micros BETWEEN 0 AND 10000000)));
