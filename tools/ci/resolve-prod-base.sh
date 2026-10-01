#!/usr/bin/env bash
# Resolve what production runs, for the upgrade job: the commit its images were built
# from and the schema its database is on. Used by .github/workflows/greenfield.yml and
# run end to end by test/ops/resolveProdBase.check.ts.
#
# Why: the repository variables FSS_PROD_COMMIT and FSS_PROD_SCHEMA go stale after every
# autodeploy (autodeploys move production, not the variables). That broke PR 344 and
# again during releases 0028-0030. Production's public /health attests both, so it is
# the only source. There is NO fallback and the variables are not read.
#
# Only a branch that changes the schema or a migration runs this (the workflow decides
# that from the repository alone), so /health must be attested or this FAILS, with the
# reason: curl exit 0, HTTP 200 (a redirect is not production), JSON, status "serving",
# schema accepted, a usable schema.databaseVersion and a full 40-hex build.commit.
#
# Inputs (environment):
#   FSS_PRODUCTION_ORIGIN  production API origin, e.g. https://api.usecallie.com
#   GITHUB_OUTPUT          where `commit=` and `schema=` are written
#   RESOLVE_ATTEMPTS / RESOLVE_PAUSE  retry count (default 3) and pause seconds (5)
#
# Expected /health shape:
#   {"status":"serving","build":{"commit":"<40 hex>"},
#    "schema":{"databaseVersion":30,"accepted":true},...}
set -euo pipefail

output="${GITHUB_OUTPUT:-/dev/null}"
origin="${FSS_PRODUCTION_ORIGIN:-}"
attempts="${RESOLVE_ATTEMPTS:-3}"
pause="${RESOLVE_PAUSE:-5}"
zero=0000000000000000000000000000000000000000

# Text that came from the network or a variable, made safe to put in a workflow
# annotation: one line, no `::` command marker, bounded (500 characters).
clean() { printf '%s' "$1" | tr '\r\n' '  ' | sed 's/::/: :/g' | cut -c1-500; }
fail() { echo "::error::$(clean "$1")"; exit 1; }

is_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [ "$1" != "$zero" ]; }
is_schema() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$((10#$1))" -gt 0 ]; }

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
[ -n "$health_commit" ] || fail "production's /health cannot be attested ($reason), so this branch's schema change has no production base to be tested from. Retry when production answers"

echo "production runs schema $health_schema at $health_commit (attested by /health)"
{
  echo "commit=$health_commit"
  echo "schema=$health_schema"
} >> "$output"
