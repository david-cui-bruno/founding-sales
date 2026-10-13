-- changes: workspace_settings, provider_reservations
-- Reuse immutable administrative setting versions and the existing conserved money ledger.
ALTER TABLE workspace_settings DROP CONSTRAINT workspace_settings_key_known,
 ADD CONSTRAINT workspace_settings_key_known CHECK(setting_key IN (
 'business_time_zone','postal_address','sending_enabled','calling_provider','calendar_integration',
 'telephony_budget','voicemail_script','call_transcription','monthly_cash_ceiling_cents',
 'meeting_transcription','meeting_analysis','meeting_follow_through','meeting_auto_recording','booking_policy'));
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_subject_known,
 ADD CONSTRAINT provider_reservations_subject_known CHECK(subject_kind IN (
 'research_run','call_session','call_transcription','reply_classification','call_summary','call_analysis',
 'meeting_transcription','meeting_analysis','sourcing_qualification','outreach_reply','social_draft',
 'crm_extraction','crm_ask_answer','crm_ask_embedding','crm_ask_support','booking_interpretation'));
