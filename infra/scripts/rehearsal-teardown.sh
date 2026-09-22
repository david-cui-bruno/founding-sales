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
# The teardown is deliberately in six parts and in this order:
#
#   1. the restored instance step 1 of the drill created, which Terraform does not know
#      about and which would otherwise outlive the run and keep billing;
#   2. any manual snapshot carrying this run's prefix, for the same reason and with a
#      worse failure mode: a snapshot outlives the instance and holds the drill's data;
#   3. the journal objects, with the bypass, because `terraform destroy` cannot delete
#      a bucket that still has object-locked objects in it;
#   4. the root itself;
#   5. the journal bucket, if the destroy left it, because Terraform removes only what
#      its state holds;
#   6. the run's own state object, because the S3 backend does not delete state on
#      destroy — see the section below.
#
# ## The state object every run used to leave (21 September)
#
# Terraform's S3 backend writes state and never removes it: after a successful destroy
# the object at `fss/greenfield/rehearsal/<prefix>/terraform.tfstate` is still there,
# holding an empty resource list. One per run, for ever. David deleted the first by
# hand. Step 6 deletes it, and only under three conditions, because a state object is
# the only record of what a failed destroy left standing:
#
#   * the destroy completed, or the state was already empty;
#   * the key is this run's, by equality, classified by
#     `rehearsal_classify_state_key` — the durable registry key
#     `fss/greenfield/rehearsal-registry/terraform.tfstate` is refused by name, and so
#     is production's;
#   * the object parses as Terraform state and holds zero resources. Anything else is
#     left where it is and named.
#
# What step 6 does **not** remove is the DynamoDB digest item the backend keeps beside
# the lock, `<bucket>/<key>-md5`. It is tens of bytes, it is keyed by this run's own
# path so it can collide with nothing, and deleting it is a second mutation in a second
# service with no second guard. The one case where it matters is documented with its
# one-line fix in `docs/decisions/g21-the-teardown-removes-its-state-object.md`.
#
# ## The bucket the first orphan teardown did not see (21 September, Actions 35649752231)
#
# The journal module names its bucket `<prefix>-suppression-journal-<account id>`
# (`infra/modules/journal/main.tf`). Until this revision the script named it without
# the account, so step 3 listed a bucket that does not exist, was told NoSuchBucket,
# and said "already absent" — truthfully, about the wrong bucket. The run's state held
# the bucket's policy, lock configuration, versioning and public-access block and not
# the bucket, so `Destroy complete! Resources: 4 destroyed.` was also true and the
# bucket stood. The name now carries the account of the session the check below
# verified, and step 5 deletes the bucket by name when the destroy has not: it is this
# run's by construction, step 3 emptied it, and an empty bucket can be deleted whatever
# its object lock says. A bucket that still has objects is a failure here, not a
# tolerated absence, because it means step 3 did not do its job.
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

# The destroy below runs with `-var=assume_deployment_role=false`, because this
# session already is `fss-rh-deploy` and the provider must not assume the role it
# already holds. That flag hands the question of *which* principal this destroy is to
# the ambient credentials, so it is answered before anything is deleted: an identity
# that is not an assumed-role session of `fss-rh-deploy` stops the teardown here, with
# the environment still standing, rather than issuing deletes as somebody else.
rehearsal_require_deployment_session "${FSS_REHEARSAL_DEPLOYMENT_ROLE:-fss-rh-deploy}"

# The journal bucket, by the name the module gives it. The account is the verified
# session's (set by the check above); a dry run has no session and shows a placeholder.
if [ -n "${FSS_REHEARSAL_JOURNAL_BUCKET:-}" ]; then
  JOURNAL_BUCKET="$FSS_REHEARSAL_JOURNAL_BUCKET"
elif [ -n "${REHEARSAL_SESSION_ACCOUNT:-}" ]; then
  JOURNAL_BUCKET="${PREFIX}-suppression-journal-${REHEARSAL_SESSION_ACCOUNT}"
elif rehearsal_dry_run; then
  JOURNAL_BUCKET="${PREFIX}-suppression-journal-<account>"
else
  echo "FAIL: the session's account is unknown, so the journal bucket cannot be named; set FSS_REHEARSAL_JOURNAL_BUCKET to name it" >&2
  exit 1
fi
rehearsal_refuse_production_arguments "$JOURNAL_BUCKET"

# This run's state object, derived exactly as the workflow's init step derives it:
#
#   terraform init -reconfigure -backend-config=backend.hcl \
#     -backend-config="key=fss/greenfield/rehearsal/${prefix}/terraform.tfstate"
#
# so the bucket is whatever `infra/roots/rehearsal/backend.hcl` says and the key is
# this prefix's. Both are read rather than written down, and both are classified
# before the first delete of the run rather than beside the last one.
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_BUCKET="$(rehearsal_state_bucket "$REPOSITORY_ROOT/infra/roots/rehearsal/backend.hcl")"
STATE_KEY="$(rehearsal_state_key "$PREFIX")"
rehearsal_refuse_production_arguments "$STATE_BUCKET" "$STATE_KEY"
if ! STATE_KEY_CLASS="$(rehearsal_classify_state_key "$PREFIX" "$STATE_KEY")"; then
  echo "FAIL: $STATE_KEY is a '$STATE_KEY_CLASS' state key; a teardown may delete only this run's" >&2
  exit 1
fi

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
rehearsal_log "0/6 stopping any one-off task still running in ${PREFIX}-cluster"
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

rehearsal_log "1/6 deleting the restored database instance the drill created"
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

rehearsal_log "2/6 deleting any manual snapshot this run left behind"
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

rehearsal_log "3/6 emptying the object-locked journal bucket with bypass-governance"
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

rehearsal_log "4/6 destroying the rehearsal root"
if rehearsal_dry_run; then
  rehearsal_plan "terraform state list -> if the root was never initialised there is nothing to destroy"
  rehearsal_plan "run.auto.tfvars.json must exist beside the root: destroy requires every variable apply did"
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
    # `terraform destroy` requires every variable `apply` did, and this shell has
    # none of the create step's values. The create step writes them to
    # `run.auto.tfvars.json` beside the root for exactly this moment (identifiers
    # only; ignored by `infra/.gitignore`). Refusing here is better than what the
    # alternative looks like: a destroy refused with "input variable ... is not set"
    # and a rehearsal environment left standing at hourly cost. To tear down by hand
    # from a fresh checkout, recreate the file from the release record's two digests
    # (release.md section 3, step 13).
    if [ ! -f run.auto.tfvars.json ]; then
      echo "FAIL: run.auto.tfvars.json is absent beside the rehearsal root, so terraform destroy has no values for the variables the root requires; recreate it as docs/greenfield/release.md section 3 step 13 describes and rerun this teardown" >&2
      exit 1
    fi
    rehearsal_terraform destroy -auto-approve -input=false \
      "$REHEARSAL_NO_ASSUME_VAR" \
      -var="name_prefix=${PREFIX}"
    DESTROYED=true
  fi
fi

rehearsal_log "5/6 removing the journal bucket if the destroy left it"
if rehearsal_dry_run; then
  rehearsal_plan "aws s3api delete-bucket --bucket $JOURNAL_BUCKET"
  rehearsal_plan "  ... NoSuchBucket means the destroy removed it, which is done; BucketNotEmpty is a failure, because step 3 should have emptied it"
  JOURNAL_BUCKET_STATE=planned
else
  # Terraform removes the bucket only when its state holds it (see the header). The
  # bucket is this run's by name, step 3 emptied it, and an empty bucket can be deleted
  # whatever its object lock says. Anything but success or NoSuchBucket is raised.
  rehearsal_tolerate_absent "deleting $JOURNAL_BUCKET" \
    command "$AWS" s3api delete-bucket --bucket "$JOURNAL_BUCKET"
  JOURNAL_BUCKET_STATE=gone
fi

rehearsal_log "6/6 removing this run's own state object, which the S3 backend leaves behind"
STATE_OBJECT_PROBLEM=''
if rehearsal_dry_run; then
  rehearsal_plan "aws s3api get-object --bucket $STATE_BUCKET --key $STATE_KEY <file>"
  rehearsal_plan "  ... delete it only if it parses as Terraform state with zero resources; anything else is left and named"
  rehearsal_plan "aws s3api delete-object --bucket $STATE_BUCKET --key $STATE_KEY"
  rehearsal_plan "  ... NoSuchKey means the backend never wrote one, which is done, not failed"
  rehearsal_plan "  ... the lock table keeps the digest item ${STATE_BUCKET}/${STATE_KEY}-md5, which this teardown does not touch"
  STATE_OBJECT=planned
else
  case "$DESTROYED" in
    true | nothing_created)
      # The state object is the only record of what a destroy left standing, so it is
      # read before it is deleted and deleted only when it says there is nothing left.
      STATE_WORK="$(mktemp -d)"
      STATE_BODY="$STATE_WORK/terraform.tfstate"
      # Not inside the `if` below: a read that failed for any reason but NoSuchKey — an
      # `AccessDenied`, a throttle — must stop the teardown, and a condition context
      # suppresses errexit, which would have turned "I was not allowed to look" into
      # "there is nothing there".
      set +e
      rehearsal_tolerate_absent "reading s3://$STATE_BUCKET/$STATE_KEY" \
        command "$AWS" s3api get-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" "$STATE_BODY" >/dev/null
      STATE_READ_STATUS=$?
      set -e
      if [ "$STATE_READ_STATUS" -ne 0 ]; then
        echo "FAIL: s3://$STATE_BUCKET/$STATE_KEY could not be read, and not because it was absent" >&2
        exit 1
      fi
      if [ -f "$STATE_BODY" ]; then
        set +e
        STATE_VERDICT="$(python3 - "$STATE_BODY" <<'PY'
# Is this an empty Terraform state? Exit 0 for yes, 2 for "not Terraform state I can
# read", 3 for "it still holds resources". The verdict is one line on stdout either
# way, because the teardown report names what was left and why.
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        state = json.load(handle)
except Exception as error:  # noqa: BLE001 - any unreadable object is the same answer
    print(f"it did not parse as JSON ({type(error).__name__})")
    raise SystemExit(2)

if not isinstance(state, dict) or not isinstance(state.get("version"), int) or not isinstance(
    state.get("lineage"), str
):
    print("it parsed, and it is not a Terraform state object (no integer version and string lineage)")
    raise SystemExit(2)

resources = state.get("resources", [])
if not isinstance(resources, list):
    print("its resources member is not a list, so it cannot be read as empty")
    raise SystemExit(2)
if resources:
    print(f"it still holds {len(resources)} resource(s), so the destroy did not finish")
    raise SystemExit(3)

print(f"empty Terraform state, version {state['version']}, serial {state.get('serial', 'unknown')}")
raise SystemExit(0)
PY
)"
        STATE_VERDICT_STATUS=$?
        set -e
        if [ "$STATE_VERDICT_STATUS" -eq 0 ]; then
          rehearsal_tolerate_absent "deleting s3://$STATE_BUCKET/$STATE_KEY" \
            command "$AWS" s3api delete-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" >/dev/null
          rehearsal_log "removed the ${STATE_KEY_CLASS} state object s3://$STATE_BUCKET/$STATE_KEY: $STATE_VERDICT"
          STATE_OBJECT=removed
        else
          rehearsal_log "left s3://$STATE_BUCKET/$STATE_KEY where it is: $STATE_VERDICT"
          STATE_OBJECT=refused
          STATE_OBJECT_PROBLEM="$STATE_VERDICT"
        fi
      else
        rehearsal_log "s3://$STATE_BUCKET/$STATE_KEY is not there, so this run wrote no state to remove"
        STATE_OBJECT=absent
      fi
      rm -rf "$STATE_WORK"
      ;;
    *)
      # Unreachable today: the destroy step either sets one of the two above or exits.
      # A future branch that does neither must not reach a delete.
      rehearsal_log "the destroy reported '${DESTROYED}', so the state object stays where it is"
      STATE_OBJECT=refused
      STATE_OBJECT_PROBLEM="the destroy reported '${DESTROYED}', which is neither a completed destroy nor an empty state"
      ;;
  esac
fi

rehearsal_write_report "teardown.txt" \
  "prefix=$PREFIX destroyed=${DESTROYED} journal_bucket=${JOURNAL_BUCKET_STATE} state_object=${STATE_OBJECT}"
if [ -n "$STATE_OBJECT_PROBLEM" ]; then
  echo "FAIL: s3://$STATE_BUCKET/$STATE_KEY was not removed: $STATE_OBJECT_PROBLEM" >&2
  echo "      Everything above this step ran. Read the object before deleting anything by hand." >&2
  exit 1
fi
rehearsal_log "what is left of this run: the lock table's digest item ${STATE_BUCKET}/${STATE_KEY}-md5, and nothing else"
rehearsal_log "torn down; run rehearsal-prefix-guard.sh $PREFIX after to prove production was untouched"
