-- changes: sourcing_targeting_versions
-- More approved selectors, with unchanged byte, source, dispatch and spending guards.
-- Existing immutable policy rows are neither rewritten nor activated.
ALTER TABLE sourcing_targeting_versions
 DROP CONSTRAINT sourcing_targeting_versions_queries_check,
 ADD CONSTRAINT sourcing_targeting_versions_queries_check CHECK(
  jsonb_typeof(queries)='array' AND jsonb_array_length(queries) BETWEEN 1 AND 64
  AND octet_length(queries::text)<=32768
 );
