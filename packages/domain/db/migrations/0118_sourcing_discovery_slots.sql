-- changes: sourcing_discovery_settings, sourcing_discovery_attempts
-- Preserve all historical discovery attempts as slot zero. Higher throughput
-- remains opt-in: existing workspaces continue at one search per UTC day.
ALTER TABLE sourcing_discovery_settings
  ADD COLUMN searches_per_day smallint NOT NULL DEFAULT 1
  CONSTRAINT sourcing_discovery_searches_per_day CHECK (searches_per_day BETWEEN 1 AND 10);

ALTER TABLE sourcing_discovery_attempts
  ADD COLUMN slot smallint NOT NULL DEFAULT 0
  CONSTRAINT sourcing_discovery_slot CHECK (slot BETWEEN 0 AND 9);

ALTER TABLE sourcing_discovery_attempts
  DROP CONSTRAINT sourcing_discovery_attempts_workspace_id_day_key,
  ADD CONSTRAINT sourcing_discovery_attempts_workspace_day_slot UNIQUE (workspace_id, day, slot);
