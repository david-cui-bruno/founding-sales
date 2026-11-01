-- changes: sourcing_discovery_settings, sourcing_discovery_attempts
-- Supply raise (approved Nov 1 2026): up to twenty discovery searches per workspace day, one
-- slot per search. Both bounds only widen: every stored value (1..10 searches, slots 0..9) still
-- satisfies them, nothing is rewritten, and the daily/monthly credit stops stay in code.
ALTER TABLE sourcing_discovery_settings DROP CONSTRAINT sourcing_discovery_searches_per_day;
ALTER TABLE sourcing_discovery_settings ADD CONSTRAINT sourcing_discovery_searches_per_day CHECK (searches_per_day BETWEEN 1 AND 20);
ALTER TABLE sourcing_discovery_attempts DROP CONSTRAINT sourcing_discovery_slot;
ALTER TABLE sourcing_discovery_attempts ADD CONSTRAINT sourcing_discovery_slot CHECK (slot BETWEEN 0 AND 19);
