#!/usr/bin/env bash
# Resolve what production runs, for the upgrade job: the commit its images were built
# from and the schema its database is on. Used by .github/workflows/greenfield.yml and
# run end to end by test/ops/resolveProdBase.check.ts.
#
# Why: the repository variables FSS_PROD_COMMIT and FSS_PROD_SCHEMA go stale after every
# autodeploy (autodeploys move production, not the variables). That broke PR 344 and
# again during releases 0028-0030. Production's public /health attests both, so it is
# the source; the variables are only the fallback when /health cannot be used.
#
# Inputs (environment):
#   FSS_PRODUCTION_ORIGIN  production API origin, e.g. https://api.usecallie.com
#   VAR_PROD_COMMIT        vars.FSS_PROD_COMMIT (fallback; may be empty)
#   VAR_PROD_SCHEMA        vars.FSS_PROD_SCHEMA (fallback; may be empty)
#   GITHUB_OUTPUT          where `commit=`, `schema=`, `source=` are written
#   RESOLVE_ATTEMPTS / RESOLVE_PAUSE  retry count (default 3) and pause seconds (5)
#
# Expected /health shape:
#   {"status":"serving","build":{"commit":"<40 hex>"},
#    "schema":{"databaseVersion":30,"accepted":true},...}
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }
output="${GITHUB_OUTPUT:-/dev/null}"
origin="${FSS_PRODUCTION_ORIGIN:-}"
var_commit="${VAR_PROD_COMMIT:-}"
var_schema="${VAR_PROD_SCHEMA:-}"
attempts="${RESOLVE_ATTEMPTS:-3}"
pause="${RESOLVE_PAUSE:-5}"
zero=0000000000000000000000000000000000000000

is_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [ "$1" != "$zero" ]; }
is_schema() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -gt 0 ]; }

# Sets health_* when /health can be used, else `reason` says why not. Not run in a
# subshell: the results are variables.
health_commit=''
health_schema=''
read_health() {
  [ -n "$origin" ] || { reason='FSS_PRODUCTION_ORIGIN is unset'; return; }
  local body code=000 attempt
  body="$(mktemp)"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    # No --location: a 3xx from anything but the production API is not production.
    # `|| true`, not `|| echo 000`: curl writes the code itself even when it fails.
    code="$(curl --silent --max-time 10 -o "$body" -w '%{http_code}' "$origin/health" 2>/dev/null || true)"
    [ -n "$code" ] || code=000
    [ "$code" = 200 ] && break
    [ "$attempt" = "$attempts" ] || sleep "$pause"
  done
  [ "$code" = 200 ] || { reason="$origin/health did not answer 200 in $attempts attempts (last status $code)"; return; }
  jq -e . "$body" >/dev/null 2>&1 || { reason='/health did not answer JSON'; return; }
  local status accepted version commit
  status="$(jq -r '.status // ""' "$body" 2>/dev/null || true)"
  accepted="$(jq -r '.schema.accepted // false' "$body" 2>/dev/null || true)"
  version="$(jq -r '.schema.databaseVersion // empty' "$body" 2>/dev/null || true)"
  commit="$(jq -r '.build.commit // empty' "$body" 2>/dev/null || true)"
  [ "$status" = serving ] || { reason="/health says status '$status', not 'serving'"; return; }
  [ "$accepted" = true ] || { reason="/health says the service does not accept its own schema"; return; }
  is_schema "$version" || { reason='/health does not report a usable schema.databaseVersion'; return; }
  is_commit "$commit" || { reason='/health does not report a full 40-hex build.commit'; return; }
  health_commit="$commit"
  health_schema="$((10#$version))"
}

reason=''
read_health
if [ -n "$health_commit" ]; then
  commit="$health_commit"
  schema="$health_schema"
  source=health
  if [ -n "$var_commit" ] && [ "$var_commit" != "$commit" ]; then
    echo "::notice title=FSS_PROD_COMMIT is stale::production's /health says $commit; the variable FSS_PROD_COMMIT says $var_commit. /health is used. Set the variable to $commit (the deploy workflow prints what to set)."
  fi
  if [ -n "$var_schema" ] && [ "$var_schema" != "$schema" ]; then
    echo "::notice title=FSS_PROD_SCHEMA is stale::production's /health says schema $schema; the variable FSS_PROD_SCHEMA says $var_schema. /health is used."
  fi
else
  [ -n "$var_commit" ] && [ -n "$var_schema" ] \
    || fail "production's /health cannot be used ($reason) and the repository variables FSS_PROD_COMMIT and FSS_PROD_SCHEMA are not both set; this job cannot say what production runs"
  echo "::warning title=Using the repository variables::production's /health cannot be used ($reason), so FSS_PROD_COMMIT and FSS_PROD_SCHEMA are taken on trust; they may be stale after an autodeploy."
  commit="$var_commit"
  schema="$var_schema"
  source=variables
  is_schema "$schema" || fail "FSS_PROD_SCHEMA is '$schema', which is not a schema version"
  schema="$((10#$schema))"
fi
is_commit "$commit" || fail "the production commit '$commit' is not a full 40-hex sha, or is the zero commit"

echo "production runs schema $schema at $commit (from $source)"
{
  echo "commit=$commit"
  echo "schema=$schema"
  echo "source=$source"
} >> "$output"
