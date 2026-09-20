#!/usr/bin/env bash
# Tear a rehearsal run down, including the object-locked journal bucket.
#
#   infra/scripts/rehearsal-teardown.sh <fss-rh-run>
#
# `docs/greenfield/infra-apply-runbook.md` 3.1: "the rehearsal journal bucket uses
# GOVERNANCE object lock with a one-day retention. Objects written during the run
# refuse deletion until that day passes, so a same-day destroy leaves the bucket
# behind. Either wait a day, or have the rehearsal role carry
# `s3:BypassGovernanceRetention` scoped to `fss-rh-*` buckets only."
#
# A rehearsal run is per-release and same-day, so the bypass is the path, and it is
# exercised here rather than left to a person to remember. The grant is on the
# rehearsal deployment role only; `docs/greenfield/release.md` says why it must never
# be on the production role and what to check if it ever appears there.
#
# The teardown is deliberately in three parts and in this order:
#
#   1. the restored instance step 1 of the drill created, which Terraform does not know
#      about and which would otherwise outlive the run and keep billing;
#   2. the journal objects, with the bypass, because `terraform destroy` cannot delete
#      a bucket that still has object-locked objects in it;
#   3. the root itself.
#
# Every one of them goes through `rehearsal_aws`, which refuses any argument naming the
# production prefix before the call is made.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

JOURNAL_BUCKET="${FSS_REHEARSAL_JOURNAL_BUCKET:-${PREFIX}-suppression-journal}"
rehearsal_refuse_production_arguments "$JOURNAL_BUCKET"

rehearsal_log "1/3 deleting the restored database instance the drill created"
rehearsal_aws rds delete-db-instance \
  --db-instance-identifier "${PREFIX}-pg-restored" \
  --skip-final-snapshot \
  --delete-automated-backups

rehearsal_log "2/3 emptying the object-locked journal bucket with bypass-governance"
if rehearsal_dry_run; then
  rehearsal_plan "list every version in $JOURNAL_BUCKET and delete it with --bypass-governance-retention"
else
  # Every version and every delete marker: an object-locked bucket keeps both, and
  # `terraform destroy` fails on either.
  versions="$(command aws s3api list-object-versions --bucket "$JOURNAL_BUCKET" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"
  markers="$(command aws s3api list-object-versions --bucket "$JOURNAL_BUCKET" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json)"
  for batch in "$versions" "$markers"; do
    if [ "$(printf '%s' "$batch" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("Objects") or []))')" -gt 0 ]; then
      command aws s3api delete-objects --bucket "$JOURNAL_BUCKET" \
        --bypass-governance-retention \
        --delete "$batch"
    fi
  done
fi

rehearsal_log "3/3 destroying the rehearsal root"
rehearsal_terraform destroy -auto-approve -input=false \
  -var="name_prefix=${PREFIX}"

rehearsal_write_report "teardown.txt" "prefix=$PREFIX destroyed=true"
rehearsal_log "torn down; run rehearsal-prefix-guard.sh $PREFIX after to prove production was untouched"
