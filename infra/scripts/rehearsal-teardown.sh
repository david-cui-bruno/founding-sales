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
# The teardown is deliberately in four parts and in this order:
#
#   1. the restored instance step 1 of the drill created, which Terraform does not know
#      about and which would otherwise outlive the run and keep billing;
#   2. any manual snapshot carrying this run's prefix, for the same reason and with a
#      worse failure mode: a snapshot outlives the instance and holds the drill's data;
#   3. the journal objects, with the bypass, because `terraform destroy` cannot delete
#      a bucket that still has object-locked objects in it;
#   4. the root itself.
#
# Every one of them goes through `rehearsal_aws`, which refuses any argument naming the
# production prefix before the call is made.
#
# ## A run that created nothing
#
# The first credentialed rehearsal (Actions 35548888865) refused before the apply, so
# nothing existed when `if: always()` brought the teardown here — and step 1 stopped it
# dead with `DBInstance fss-rh-202609210049-pg-restored not found`, which meant steps 2
# to 4 never ran. A teardown that cannot survive a failed creation is a teardown that
# stops working exactly when it is most needed, so every step now treats absence as
# already-done and says so. Absence is the AWS error code, not any failure:
# `rehearsal_tolerate_absent` still fails on an `AccessDenied` or a throttle, because
# "it is gone" and "I was not allowed to look" must not report the same thing.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

JOURNAL_BUCKET="${FSS_REHEARSAL_JOURNAL_BUCKET:-${PREFIX}-suppression-journal}"
rehearsal_refuse_production_arguments "$JOURNAL_BUCKET"

# The destroy below runs with `-var=assume_deployment_role=false`, because this
# session already is `fss-rh-deploy` and the provider must not assume the role it
# already holds. That flag hands the question of *which* principal this destroy is to
# the ambient credentials, so it is answered before anything is deleted: an identity
# that is not an assumed-role session of `fss-rh-deploy` stops the teardown here, with
# the environment still standing, rather than issuing deletes as somebody else.
rehearsal_require_deployment_session "${FSS_REHEARSAL_DEPLOYMENT_ROLE:-fss-rh-deploy}"

AWS="$(rehearsal_aws_command)"

# ---------------------------------------------------------------------------
# 0. Stop every task still running in this run's cluster (G12h).
#
# The drill and the deployment now launch one-off tasks (`fss migrate`,
# `fss admin database-users ensure`, `fss verify`, `fss drill`). A run that failed
# part-way can leave one of them running, and a running task holds an elastic network
# interface in a subnet Terraform is about to delete: `terraform destroy` then waits
# on the subnet until it times out, and the report says the teardown failed for a
# reason that has nothing to do with the subnet.
#
# Stopping is by task ARN, and every ARN is classified before it is addressed, so a
# task belonging to another run — or to production — is never a candidate. A cluster
# that does not exist is already done.
# ---------------------------------------------------------------------------
rehearsal_log "0/4 stopping any one-off task still running in ${PREFIX}-cluster"
if rehearsal_dry_run; then
  rehearsal_plan "aws ecs list-tasks --cluster ${PREFIX}-cluster --desired-status RUNNING"
  rehearsal_plan "  ... stop each, and ClusterNotFoundException means the apply never created it, which is done, not failed"
else
  rehearsal_refuse_production_arguments "${PREFIX}-cluster"
  running="$(rehearsal_tolerate_absent "listing running tasks in ${PREFIX}-cluster" \
    command "$AWS" ecs list-tasks --cluster "${PREFIX}-cluster" --desired-status RUNNING \
    --query 'taskArns' --output json)"
  for task_arn in $(printf '%s' "${running:-[]}" | python3 -c 'import json,sys
raw = sys.stdin.read().strip() or "[]"
for arn in json.loads(raw) or []:
    print(arn)'); do
    # An ECS task ARN is `.../task/<cluster>/<id>`, so the classifier sees the
    # cluster name and refuses anything that is not this run's.
    if [ "$(rehearsal_classify_name "$PREFIX" "${task_arn##*:task/}" || true)" != "rehearsal-run" ]; then
      rehearsal_log "not this run's task, leaving it alone: $task_arn"
      continue
    fi
    rehearsal_tolerate_absent "stopping $task_arn" \
      command "$AWS" ecs stop-task --cluster "${PREFIX}-cluster" --task "$task_arn" \
      --reason "rehearsal teardown" >/dev/null
  done
fi

rehearsal_log "1/4 deleting the restored database instance the drill created"
if rehearsal_dry_run; then
  rehearsal_plan "aws rds delete-db-instance --db-instance-identifier ${PREFIX}-pg-restored --skip-final-snapshot --delete-automated-backups"
  rehearsal_plan "  ... and DBInstanceNotFound means the drill never created it, which is done, not failed"
else
  rehearsal_refuse_production_arguments "${PREFIX}-pg-restored"
  rehearsal_tolerate_absent "deleting ${PREFIX}-pg-restored" \
    command "$AWS" rds delete-db-instance \
    --db-instance-identifier "${PREFIX}-pg-restored" \
    --skip-final-snapshot \
    --delete-automated-backups
fi

rehearsal_log "2/4 deleting any manual snapshot this run left behind"
if rehearsal_dry_run; then
  rehearsal_plan "aws rds describe-db-snapshots --snapshot-type manual -> delete every identifier classified as this run's"
else
  # Listed by type rather than by instance: `--db-instance-identifier` on an instance
  # that no longer exists is a DBInstanceNotFound, and the snapshots are exactly what
  # outlives the instance. Every identifier goes through the classifier, so a snapshot
  # that is not this run's is never a candidate for deletion.
  snapshots="$(rehearsal_tolerate_absent "listing manual snapshots" \
    command "$AWS" rds describe-db-snapshots --snapshot-type manual \
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output json)"
  for identifier in $(printf '%s' "${snapshots:-[]}" | python3 -c 'import json,sys
raw = sys.stdin.read().strip() or "[]"
for name in json.loads(raw) or []:
    print(name)'); do
    if [ "$(rehearsal_classify_name "$PREFIX" "$identifier" || true)" != "rehearsal-run" ]; then
      continue
    fi
    rehearsal_tolerate_absent "deleting snapshot $identifier" \
      command "$AWS" rds delete-db-snapshot --db-snapshot-identifier "$identifier"
  done
fi

rehearsal_log "3/4 emptying the object-locked journal bucket with bypass-governance"
if rehearsal_dry_run; then
  rehearsal_plan "list every version in $JOURNAL_BUCKET and delete it with --bypass-governance-retention"
  rehearsal_plan "  ... and NoSuchBucket means the apply never created it, which is done, not failed"
else
  # Every version and every delete marker: an object-locked bucket keeps both, and
  # `terraform destroy` fails on either. A bucket that was never created is neither.
  versions="$(rehearsal_tolerate_absent "listing versions in $JOURNAL_BUCKET" \
    command "$AWS" s3api list-object-versions --bucket "$JOURNAL_BUCKET" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)"
  markers="$(rehearsal_tolerate_absent "listing delete markers in $JOURNAL_BUCKET" \
    command "$AWS" s3api list-object-versions --bucket "$JOURNAL_BUCKET" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json)"
  for batch in "$versions" "$markers"; do
    [ -n "$batch" ] || continue
    if [ "$(printf '%s' "$batch" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("Objects") or []))')" -gt 0 ]; then
      rehearsal_tolerate_absent "emptying $JOURNAL_BUCKET" \
        command "$AWS" s3api delete-objects --bucket "$JOURNAL_BUCKET" \
        --bypass-governance-retention \
        --delete "$batch"
    fi
  done
fi

rehearsal_log "4/4 destroying the rehearsal root"
if rehearsal_dry_run; then
  rehearsal_plan "terraform state list -> if the root was never initialised there is nothing to destroy"
  rehearsal_terraform destroy -auto-approve -input=false \
    "$REHEARSAL_NO_ASSUME_VAR" \
    -var="name_prefix=${PREFIX}"
  DESTROYED=planned
else
  # `terraform destroy` in an uninitialised root fails with "Backend initialization
  # required", which is precisely what a job whose creation step never ran looks like:
  # the init happens in the create step. An empty state is the same fact with the init
  # done. Both are "nothing was created"; anything else is a real failure and is raised.
  set +e
  state="$(command "${TERRAFORM:-terraform}" state list 2>&1)"
  state_status=$?
  set -e
  if [ "$state_status" -ne 0 ]; then
    case "$state" in
      *"Backend initialization required"*|*"Initialization required"*|*"No state file was found"*|*"Missing backend configuration"*)
        rehearsal_log "the root was never initialised, so this run created nothing to destroy:"
        printf '%s\n' "$state" | head -3 | sed 's/^/  /'
        DESTROYED=nothing_created
        ;;
      *)
        printf '%s\n' "$state" >&2
        echo "FAIL: the rehearsal state could not be read, and not because the run created nothing" >&2
        exit 1
        ;;
    esac
  elif [ -z "$(printf '%s' "$state" | tr -d '[:space:]')" ]; then
    rehearsal_log "the rehearsal state is empty, so this run created nothing to destroy"
    DESTROYED=nothing_created
  else
    rehearsal_terraform destroy -auto-approve -input=false \
      "$REHEARSAL_NO_ASSUME_VAR" \
      -var="name_prefix=${PREFIX}"
    DESTROYED=true
  fi
fi

rehearsal_write_report "teardown.txt" "prefix=$PREFIX destroyed=${DESTROYED}"
rehearsal_log "torn down; run rehearsal-prefix-guard.sh $PREFIX after to prove production was untouched"
