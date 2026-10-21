-- changes: meeting_follow_through
-- Draft-only. Never widens legacy max-three enrolled/sent ordinals or permissions.
ALTER TABLE meeting_follow_through ADD COLUMN unpublished_plan jsonb;
ALTER TABLE meeting_follow_through ADD CONSTRAINT meeting_unpublished_plan_shape CHECK (
  unpublished_plan IS NULL OR (
    jsonb_typeof(unpublished_plan) = 'object'
    AND unpublished_plan->'schemaVersion' = '1'::jsonb
    AND unpublished_plan->>'state' = 'unpublished'
    AND unpublished_plan->>'cadence' = 'post_demo_3_7_14'
    AND unpublished_plan->>'sourceHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(unpublished_plan->'notesRevision') = 'number'
    AND (unpublished_plan->>'notesRevision') ~ '^(0|[1-9][0-9]*)$'
    AND jsonb_typeof(unpublished_plan->'revision') = 'number'
    AND (unpublished_plan->>'revision') ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(unpublished_plan->'savedAt') = 'string'
    AND jsonb_typeof(unpublished_plan->'messages') = 'array'
    AND jsonb_array_length(unpublished_plan->'messages') = 4
    AND unpublished_plan->'messages'->0->'ordinal' = '1'::jsonb
    AND unpublished_plan->'messages'->1->'ordinal' = '2'::jsonb
    AND unpublished_plan->'messages'->2->'ordinal' = '3'::jsonb
    AND unpublished_plan->'messages'->3->'ordinal' = '4'::jsonb
    AND unpublished_plan->'messages'->0->'elapsedDays' = '0'::jsonb
    AND unpublished_plan->'messages'->1->'elapsedDays' = '3'::jsonb
    AND unpublished_plan->'messages'->2->'elapsedDays' = '7'::jsonb
    AND unpublished_plan->'messages'->3->'elapsedDays' = '14'::jsonb
    AND unpublished_plan->'messages'->0->'held' = 'true'::jsonb
    AND unpublished_plan->'messages'->1->'held' = 'true'::jsonb
    AND unpublished_plan->'messages'->2->'held' = 'true'::jsonb
    AND unpublished_plan->'messages'->3->'held' = 'true'::jsonb
    AND (unpublished_plan - ARRAY['schemaVersion','state','cadence','sourceHash','notesRevision','revision','savedAt','messages']) = '{}'::jsonb
  ) IS TRUE
);
-- Nested text/unknown-field strictness is checked by the contract before reads/writes.
-- The database independently fixes unpublished identity, holds, count and cadence.
