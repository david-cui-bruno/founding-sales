#!/usr/bin/env bash
# The old name of `deploy.sh release` (P7, 26 September 2026), with its `--record-only`
# form, which is `record.sh put`. Same flags, same output; kept until the release helpers
# call the new names, then deleted.
#
#   infra/scripts/release-deploy.sh <root> <prefix> [--schema-change] --api-digest D --worker-digest D [--release-record F]
#       = deploy.sh release <the same>
#   infra/scripts/release-deploy.sh <root> <prefix> --record-only --api-digest D --worker-digest D --release-record F
#       = record.sh put <root> <prefix> --api-digest D --worker-digest D --release-record F
set -euo pipefail
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

record_only=0
for argument in "$@"; do
  if [ "$argument" = --record-only ]; then record_only=1; fi
done
[ "$record_only" = 1 ] || exec "$SCRIPTS/deploy.sh" release "$@"

root=${1:-}
prefix=${2:-}
shift 2 2>/dev/null || true
schema_change=0
api=''
worker=''
record=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --record-only) shift ;;
    --schema-change) schema_change=1; shift ;;
    --api-digest) api=${2:-}; shift 2 ;;
    --worker-digest) worker=${2:-}; shift 2 ;;
    --release-record) record=${2:-}; shift 2 ;;
    *) echo "FAIL: release-deploy.sh does not take '$1'" >&2; exit 1 ;;
  esac
done
if [ -z "$root" ] || [ -z "$prefix" ]; then
  echo "usage: release-deploy.sh <terraform root> <name prefix> --record-only --api-digest D --worker-digest D --release-record <file>" >&2
  exit 1
fi
if [ -z "$record" ]; then
  echo "FAIL: --record-only stores a release record and does nothing else, so it needs --release-record <file>." >&2
  exit 1
fi
if [ "$schema_change" = 1 ]; then
  echo "FAIL: --record-only deploys nothing, so --schema-change means nothing here. Pass it to the deploy that follows." >&2
  exit 1
fi
if [ -z "$api" ] || [ -z "$worker" ]; then
  echo "FAIL: --record-only needs --api-digest and --worker-digest: the record must name exactly the release it is stored for." >&2
  exit 1
fi
exec "$SCRIPTS/record.sh" put "$root" "$prefix" --api-digest "$api" --worker-digest "$worker" --release-record "$record"
