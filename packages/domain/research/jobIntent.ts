/**
 * Only a dispatchable payload can represent a not-yet-opened research intent.
 * Both readers use the `j` jobs alias. Once a run exists its immutable purpose wins.
 * The revision key is still allocated independently, even for malformed jobs.
 */
export const VALID_RESEARCH_JOB_INTENT_SQL = `(
  jsonb_typeof(j.payload->'revision')='number'
  AND CASE WHEN j.payload->>'revision' ~ '^[1-9][0-9]{0,9}$'
    THEN (j.payload->>'revision')::bigint <= 2147483647 ELSE false END
  AND j.payload->>'trigger' IN ('firm_created','sweep','user_request','link_added')
  AND (
    COALESCE(j.payload->>'purpose','brief')='brief'
    OR (j.payload->>'purpose'='office_evidence' AND j.payload->>'trigger'='user_request'
      AND jsonb_typeof(j.payload->'requestedByUserId')='string'
      AND length(j.payload->>'requestedByUserId')>0)
  )
)`;
