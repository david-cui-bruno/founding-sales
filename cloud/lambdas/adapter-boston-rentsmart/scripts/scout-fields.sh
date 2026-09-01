#!/usr/bin/env bash
# Scouting script used to learn the RentSmart datastore fields and the
# violation_type catalog before hard-coding VIOLATION_TYPES in src/rentsmart.ts.
# Re-run when the dataset changes; diff against the comment in rentsmart.ts.
set -euo pipefail
RESOURCE="dc615ff7-2ff3-416a-922b-f0f334f085d0"
curl -s "https://data.boston.gov/api/3/action/datastore_search?resource_id=${RESOURCE}&limit=3" | python3 -m json.tool
curl -s 'https://data.boston.gov/api/3/action/datastore_search_sql' --get \
  --data-urlencode "sql=SELECT \"violation_type\", COUNT(*) AS n FROM \"${RESOURCE}\" GROUP BY \"violation_type\" ORDER BY n DESC" | python3 -m json.tool
