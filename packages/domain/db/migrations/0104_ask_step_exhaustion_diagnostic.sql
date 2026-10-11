-- changes: crm_ask_requests
-- Additive diagnostic only: preserve all historical reasons and lifecycle guards.
ALTER TABLE crm_ask_requests DROP CONSTRAINT crm_ask_requests_reason_check;
ALTER TABLE crm_ask_requests ADD CONSTRAINT crm_ask_requests_reason_check CHECK(reason IS NULL OR reason IN ('purpose_unavailable','evaluation_unavailable','processing_authority_unavailable','budget_held','input_bound_reached','step_bound_reached','source_unavailable','source_changed','purpose_changed','provider_acceptance_unknown','processing_failed','unsupported_answer','identity_clarification_required','deleted','processing_cancelled'));
