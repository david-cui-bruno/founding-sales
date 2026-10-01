#!/usr/bin/env bash
# Resolve what production runs, for the upgrade job: the commit its images were built
# from and the schema its database is on. Used by .github/workflows/greenfield.yml and
# run end to end by test/ops/resolveProdBase.check.ts.
#
# Why: the repository variables FSS_PROD_COMMIT and FSS_PROD_SCHEMA go stale after every
# autodeploy (autodeploys move production, not the variables). That broke PR 344 and
# again during releases 0028-0030. Production's public /health attests both, so it is
# the source.
#
# **The variables never certify an upgrade.** A pull request runs an upgrade when the
# schema it declares (REQUIRED_SCHEMA at HEAD) differs from the schema production runs.
# Then /health must be usable and attested: curl exit 0, HTTP 200 (a redirect is not
# production), JSON, status "serving", schema accepted, a usable schema.databaseVersion
# and a full 40-hex build.commit. Anything less, an unreachable service and an explicit
# contradiction (degraded, schema not accepted, no build commit) alike, FAILS: stale
# variables would give evidence for an upgrade nobody performs. Only when the variables
# say the branch declares the schema production is on (so there is no upgrade to test)
# is falling back to them allowed, with a warning.
#
# Inputs (environment):
#   FSS_PRODUCTION_ORIGIN  production API origin, e.g. https://api.usecallie.com
#   VAR_PROD_COMMIT        vars.FSS_PROD_COMMIT (fallback only; may be empty)
#   VAR_PROD_SCHEMA        vars.FSS_PROD_SCHEMA (fallback only; may be empty)
#   HEAD_SCHEMA            REQUIRED_SCHEMA at HEAD; read from git when unset
#   GITHUB_OUTPUT          where `commit=`, `schema=`, `source=` are written
#   RESOLVE_ATTEMPTS / RESOLVE_PAUSE  retry count (default 3) and pause seconds (5)
#
# Expected /health shape:
#   {"status":"serving","build":{"commit":"<40 hex>"},
#    "schema":{"databaseVersion":30,"accepted":true},...}
set -euo pipefail

output="${GITHUB_OUTPUT:-/dev/null}"
origin="${FSS_PRODUCTION_ORIGIN:-}"
var_commit="${VAR_PROD_COMMIT:-}"
var_schema="${VAR_PROD_SCHEMA:-}"
attempts="${RESOLVE_ATTEMPTS:-3}"
pause="${RESOLVE_PAUSE:-5}"
zero=0000000000000000000000000000000000000000

# Text that came from the network or a variable, made safe to put in a workflow
# annotation: one line, no `::` command marker, bounded (500 characters).
clean() { printf '%s' "$1" | tr '\r\n' '  ' | sed 's/::/: :/g' | cut -c1-500; }
fail() { echo "::error::$(clean "$1")"; exit 1; }

is_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [ "$1" != "$zero" ]; }
is_schema() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -gt 0 ]; }

head_schema="${HEAD_SCHEMA:-}"
if [ -z "$head_schema" ]; then
  head_schema="$(git show HEAD:packages/domain/db/schemaRange.ts 2>/dev/null \
    | sed -n 's/^export const REQUIRED_SCHEMA = \([0-9][0-9]*\);$/\1/p' || true)"
fi
is_schema "$head_schema" || fail "the schema this branch declares (REQUIRED_SCHEMA at HEAD) could not be read, so it cannot be decided whether there is an upgrade"
head_schema="$((10#$head_schema))"

# Sets health_* when /health is fully attested, else `reason` says why not. Not run in a
# subshell: the results are variables.
health_commit=''
health_schema=''
reason=''
read_health() {
  [ -n "$origin" ] || { reason='FSS_PRODUCTION_ORIGIN is unset'; return; }
  local body code=000 rc=0 attempt
  body="$(mktemp)"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    # No --location: a 3xx from anything but the production API is not production.
    # The transfer must succeed (exit 0) as well as say 200: a stalled or cut response
    # that happened to carry a 200 is not an answer. curl writes the code itself even
    # when it fails, so it is captured whatever the exit.
    rc=0
    code="$(curl --silent --max-time 10 -o "$body" -w '%{http_code}' "$origin/health" 2>/dev/null)" || rc=$?
    [ -n "$code" ] || code=000
    [ "$rc" = 0 ] && [ "$code" = 200 ] && break
    [ "$attempt" = "$attempts" ] || sleep "$pause"
  done
  if [ "$rc" != 0 ] || [ "$code" != 200 ]; then
    reason="$origin/health did not answer 200 with a clean transfer in $attempts attempts (last status $code, curl exit $rc)"
    return
  fi
  jq -e . "$body" >/dev/null 2>&1 || { reason='/health did not answer JSON'; return; }
  local status accepted version commit
  status="$(jq -r '.status // ""' "$body" 2>/dev/null || true)"
  accepted="$(jq -r '.schema.accepted // false' "$body" 2>/dev/null || true)"
  version="$(jq -r '.schema.databaseVersion // empty' "$body" 2>/dev/null || true)"
  commit="$(jq -r '.build.commit // empty' "$body" 2>/dev/null || true)"
  [ "$status" = serving ] || { reason="/health says status '$status', not 'serving'"; return; }
  [ "$accepted" = true ] || { reason='/health says the service does not accept its own schema'; return; }
  is_schema "$version" || { reason='/health does not report a usable schema.databaseVersion'; return; }
  is_commit "$commit" || { reason='/health does not report a full 40-hex build.commit'; return; }
  health_commit="$commit"
  health_schema="$((10#$version))"
}

read_health
if [ -n "$health_commit" ]; then
  commit="$health_commit"
  schema="$health_schema"
  source=health
  if [ -n "$var_commit" ] && [ "$var_commit" != "$commit" ]; then
    echo "::notice title=FSS_PROD_COMMIT is stale::production's /health says $commit; the variable FSS_PROD_COMMIT says $(clean "$var_commit"). /health is used. Set the variable to $commit (the deploy workflow prints what to set)."
  fi
  if [ -n "$var_schema" ] && [ "$var_schema" != "$schema" ]; then
    echo "::notice title=FSS_PROD_SCHEMA is stale::production's /health says schema $schema; the variable FSS_PROD_SCHEMA says $(clean "$var_schema"). /health is used."
  fi
else
  # /health cannot attest. That is survivable only when there is provably no upgrade:
  # the variables say production is on the very schema this branch declares.
  [ -n "$var_commit" ] && [ -n "$var_schema" ] \
    || fail "production's /health cannot be used ($reason) and the repository variables FSS_PROD_COMMIT and FSS_PROD_SCHEMA are not both set; this job cannot say what production runs"
  is_schema "$var_schema" || fail "FSS_PROD_SCHEMA is '$var_schema', which is not a schema version"
  schema="$((10#$var_schema))"
  [ "$schema" = "$head_schema" ] \
    || fail "this branch declares schema $head_schema and would run an upgrade, but production's /health cannot attest what production runs ($reason); the repository variables say schema $schema and are never accepted as the base of an upgrade. Retry when production answers"
  commit="$var_commit"
  source=variables
  echo "::warning title=Using the repository variables::production's /health cannot be used ($(clean "$reason")), so FSS_PROD_COMMIT and FSS_PROD_SCHEMA are taken on trust; there is no upgrade to test on this branch, but they may be stale after an autodeploy."
fi
is_commit "$commit" || fail "the production commit '$commit' is not a full 40-hex sha, or is the zero commit"

echo "production runs schema $schema at $commit (from $source)"
{
  echo "commit=$commit"
  echo "schema=$schema"
  echo "source=$source"
} >> "$output"
