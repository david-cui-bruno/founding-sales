-- changes: social_deliveries
ALTER TABLE social_deliveries ADD COLUMN media_binding jsonb
 CHECK(media_binding IS NULL OR jsonb_typeof(media_binding)='object');
