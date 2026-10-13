-- Supported profile assertions reuse source-versioned endpoint claims and their deletion closure.
-- This grants no invitation/DM channel and does not restore removed legacy sequence steps.
ALTER TABLE crm_identity_endpoints DROP CONSTRAINT crm_identity_endpoints_kind_check;
ALTER TABLE crm_identity_endpoints ADD CONSTRAINT crm_identity_endpoints_kind_check
 CHECK(kind IN ('email','phone','linkedin'));
