#!/usr/bin/env bash
# The release record (specification 16.2, Appendix G 42).
#
#   infra/scripts/rehearsal-release-record.sh <fss-rh-run> <api digest> <worker digest> \
#       <desktop commit stamp> <suite result> <out file>
#
# "Production sending remains disabled until all mandatory scenarios for the affected
# release class pass, the deployed commit/image digests match the rehearsal artifacts,
# and an authenticated admin enables sending."
#
# Four conditions. This script is what turns the first three into one durable fact an
# admin can refer to, and it is written **last** in the rehearsal workflow so that a
# record can only exist for a run that finished. `workspace_settings.sending_enabled`
# carries its `releaseGateReference`, and `packages/domain/outbound/gate.ts` refuses to
# send without it.
#
# ## What this script refuses
#
# It refuses more often than it writes, and that is the design:
#
#   * a suite result that is not `pass`;
#   * a digest that is not `sha256:` followed by 64 hex characters — a mutable tag
#     cannot carry the comparison the gate exists to make;
#   * the two digests being equal to each other (one image pushed under both names);
#   * a missing report from any rehearsal-only scenario, so a record cannot claim a
#     drill that did not run;
#   * a production prefix anywhere in its arguments.
#
# The record names the digests rather than asserting they match the deployment. The
# match is made at enable time, by the admin, against what production is actually
# running — that comparison belongs to the person taking the responsibility, not to the
# process that produced the artefacts.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 still writes the record to the given path, because
# the record is a local file and writing it is how the workflow's dry run is checked.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
API_DIGEST=${2:-}
WORKER_DIGEST=${3:-}
DESKTOP_STAMP=${4:-}
SUITE_RESULT=${5:-}
OUT=${6:-}

rehearsal_require_prefix "$PREFIX"
rehearsal_refuse_production_arguments "$@"

for name in API_DIGEST WORKER_DIGEST DESKTOP_STAMP SUITE_RESULT OUT; do
  if [ -z "${!name}" ]; then
    echo "FAIL: $name is required" >&2
    exit 1
  fi
done

if [ "$SUITE_RESULT" != "pass" ]; then
  echo "FAIL: the suite result is '$SUITE_RESULT'; a release record is only written for a green suite" >&2
  exit 1
fi

digest_shape='^sha256:[0-9a-f]{64}$'
for digest in "$API_DIGEST" "$WORKER_DIGEST"; do
  if [[ ! "$digest" =~ $digest_shape ]]; then
    echo "FAIL: '$digest' is not an image digest. The gate compares digests, and a tag is mutable." >&2
    exit 1
  fi
done
if [ "$API_DIGEST" = "$WORKER_DIGEST" ]; then
  echo "FAIL: the API and worker digests are identical; one image was pushed under both names" >&2
  exit 1
fi

# Every rehearsal-only scenario must have left a report. A record that claimed a drill
# nobody ran would be the exact failure Appendix G 42 is about.
REPORTS="$(rehearsal_report_dir)"
for report in restore-drill.txt carry-watermark.txt schema-ranges.txt prefix-guard.txt; do
  if [ ! -f "$REPORTS/$report" ]; then
    echo "FAIL: $REPORTS/$report is missing, so a rehearsal-only scenario did not run" >&2
    exit 1
  fi
done

RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REFERENCE="${PREFIX}-${RECORDED_AT}"

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<JSON
{
  "schema": "fss.release-record.v1",
  "releaseGateReference": "$REFERENCE",
  "rehearsalPrefix": "$PREFIX",
  "recordedAt": "$RECORDED_AT",
  "suite": "pass",
  "artifacts": {
    "api": "$API_DIGEST",
    "worker": "$WORKER_DIGEST",
    "desktopCommitStamp": "$DESKTOP_STAMP"
  },
  "rehearsalScenarios": {
    "11": "$(cat "$REPORTS/restore-drill.txt")",
    "20": "$(cat "$REPORTS/carry-watermark.txt")",
    "22": "$(cat "$REPORTS/schema-ranges.txt")",
    "39": "$(cat "$REPORTS/prefix-guard.txt")"
  },
  "enablesSending": false
}
JSON

rehearsal_log "wrote the release record $REFERENCE to $OUT"
rehearsal_log "sending stays disabled until an authenticated admin sets workspace_settings.sending_enabled"
rehearsal_log "to this reference AND the deployment flag FSS_SENDING_ENABLED is true on both services"
