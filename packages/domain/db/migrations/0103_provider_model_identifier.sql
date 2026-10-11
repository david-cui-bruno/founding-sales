-- changes: provider_reservations
-- Bedrock model/inference-profile versions contain a colon-delimited numeric suffix.
-- Preserve the existing bounded machine identifier syntax; never accept display names,
-- ARNs, whitespace, paths or arbitrary punctuation as a priced model identifier.
ALTER TABLE provider_reservations DROP CONSTRAINT provider_reservations_model_name_shape;
ALTER TABLE provider_reservations ADD CONSTRAINT provider_reservations_model_name_shape
 CHECK(model_name ~ '^[a-z][a-z0-9.-]{1,63}(:[0-9]{1,8})?$');
