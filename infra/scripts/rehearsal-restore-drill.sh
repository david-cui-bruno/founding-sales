#!/usr/bin/env bash
# Appendix E steps 1 to 9, and Appendix G 11.
#
#   infra/scripts/rehearsal-restore-drill.sh <fss-rh-run>
#
# `docs/greenfield/restore-drill.md` is the prose; this is the part CI runs. It follows
# the document step for step and adds the thing a document cannot: a refusal to report
# a pass when there was nothing to reconstruct.
#
# ## Where each step runs (G12h; David's decision of 21 September)
#
# The rehearsal database is private — `publicly_accessible = false`, no NAT gateway,
# no interface endpoint — so a GitHub runner cannot reach it and no step that talks to
# PostgreSQL can run here. The division is:
#
#   * **the runner keeps the control plane**: reading the latest restorable point,
#     the point-in-time restore, waiting for the instance, and the teardown. Those
#     are AWS API calls and the runner is where they belong.
#   * **two in-VPC tasks do the database work**: `fss admin counts` measures the
#     baseline on the *source* before the restore, and `fss drill` runs steps 1 to 9
#     against the restored instance in one process — one connection, one correlated
#     log stream, per-step JSON, stopping at the first step that fails.
#   * **the runner decides whether the report is a pass.** The tool says what
#     happened; the assertions below say whether that is a release. Keeping them
#     apart is what stops a change to the tool quietly relaxing the gate.
#
# A Fargate task's filesystem goes away with the task, so neither report comes back as
# a file: the wrapper captures the task's log stream and `release_captured_report`
# reads the JSON answer out of it.
#
# ## The restored instance
#
# Its endpoint is a new hostname and its credentials are the old ones — a
# point-in-time restore copies the roles and their passwords. So the endpoint travels
# as the `FSS_DATABASE_HOST` environment override, which is a public identifier and
# safe in `describe-tasks`, and the credential stays a Secrets Manager reference the
# execution role resolves. Nothing about the restored instance is ever an argument.
#
# ## The vacuous pass this script exists to prevent
#
# "A restore drill against an empty database proves nothing." Step 0.1 of the document
# says so, and it is the easiest way for this scenario to go green while testing
# nothing: restore a database with no sends, no replies and no suppressions, observe
# that nothing was lost, and write a passing report. So the baseline is measured before
# the restore target and the script exits non-zero when any of the five protected kinds
# is absent. A drill that could not be set up is a failed drill, never a skipped one.
#
# The five kinds, from Appendix G 11: an accepted send, a reply, a suppression, an
# ordinary CRM edit, and an applied migration.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every step and needs no credential, which is
# how `.github/workflows/greenfield-release.yml` is exercised in ordinary CI.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

RUN_TASK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-run-task.sh"

# `fss` is never on this machine's PATH and never needs to be. It is a command
# override of the worker image, run as a one-off ECS task inside the VPC, because the
# database is private and the worker image is the only thing already in there that can
# reach it. What the drill needs instead is the release's worker digest: the wrapper
# refuses to launch a task whose registered image is anything else, and that refusal
# is the release gate at the moment of use. A drill that reconstructed a restored
# database with last release's image would pass and prove nothing about this one.
#
# It is a precondition, named, before anything is addressed — one that discovered the
# problem at step 2 would have created a restored RDS instance first.
if ! rehearsal_dry_run && [ -z "${FSS_RELEASE_WORKER_DIGEST:-}" ]; then
  echo "FAIL: FSS_RELEASE_WORKER_DIGEST is not set, so the drill cannot launch a task whose image it can check." >&2
  echo "      The release workflow passes the dispatched worker digest; see docs/greenfield/release.md section 3." >&2
  exit 1
fi
# Step 7 below runs `rehearsal-schema-ranges.sh`, which launches the API task
# definition as well as the worker's and wants the same guarantee about each. Named
# here, with the other one, rather than discovered after a restored instance exists.
if ! rehearsal_dry_run && [ -z "${FSS_RELEASE_API_DIGEST:-}" ]; then
  echo "FAIL: FSS_RELEASE_API_DIGEST is not set, and step 7 launches the API image too." >&2
  echo "      The release workflow passes the dispatched API digest; see docs/greenfield/release.md section 3." >&2
  exit 1
fi

# The instants every "restore point minus N" is measured from. Recorded, never guessed.
DRILL_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# RDS prints `2026-09-20T21:45:00+00:00`, sometimes with a fraction. Both branches of
# the date arithmetic below parse only `YYYY-MM-DDTHH:MM:SSZ`, and the shape guard
# after this refuses anything else, so the instant is normalised where it is read.
to_utc_instant() { # to_utc_instant <RDS timestamp>
  printf '%sZ\n' "$(printf '%s' "$1" | sed -E 's/\.[0-9]+//; s/(\+00:00|Z)$//')"
}

# ---------------------------------------------------------------------------
# The wait, and why the drill cannot read its restore target without it (lane g40).
#
# `infra/scripts/release-seed-drill-evidence.sh --phase before` writes the activity
# step 0.1 requires — an accepted send, a reply, an opt-out, a salesperson's own
# suppression and a CRM edit — and records the instant it measured them at as `asOf` in
# `drill-evidence-before.txt`. RDS's continuous backup window lags real time by up to
# about five minutes (spec 4.1), so the point it will report as `LatestRestorableTime`
# a moment after that evidence was written is a point *before* the evidence existed:
# the restore would land on a database without it, the baseline measured at that
# instant would be empty, and the drill would refuse for the same reason it refused on
# 23 September 2026 — with the seeding step having run and worked.
#
# So the target is not read until the window has caught up. The comparison is on
# fourteen digits rather than on strings, because `[[ a > b ]]` is a locale collation
# and this is an ordering of instants.
RESTORABLE_WAIT_ATTEMPTS=${FSS_RESTORABLE_WAIT_ATTEMPTS:-40}
RESTORABLE_WAIT_SECONDS=${FSS_RESTORABLE_WAIT_SECONDS:-15}
EVIDENCE_REPORT="$REPORTS/drill-evidence-before.txt"
EVIDENCE_AT=''
if [ -f "$EVIDENCE_REPORT" ]; then
  EVIDENCE_AT="$(grep -o 'asOf=[^ ]*' "$EVIDENCE_REPORT" | head -1 | cut -d= -f2)"
fi

digits_of() { # digits_of <instant>
  local normalised
  normalised="$(to_utc_instant "$1")"
  printf '%s\n' "${normalised//[^0-9]/}"
}

wait_for_restorable_point() { # wait_for_restorable_point <the instant the evidence was written at>
  local evidence=$1 attempt=1 latest='' seen='' wanted=''
  if [ -z "$evidence" ]; then
    # An operator running the drill by hand against an environment somebody else
    # seeded. There is nothing to wait for and the baseline refusal below is still the
    # guard; say so rather than wait ten minutes for a file that will never appear.
    rehearsal_log "no $EVIDENCE_REPORT, so no evidence instant to wait past; the baseline refusal still decides"
    return 0
  fi
  wanted="$(digits_of "$evidence")"
  while [ "$attempt" -le "$RESTORABLE_WAIT_ATTEMPTS" ]; do
    latest="$(rehearsal_aws rds describe-db-instances \
      --db-instance-identifier "${PREFIX}-pg" \
      --query 'DBInstances[0].LatestRestorableTime' --output text)"
    if [ -n "$latest" ] && [ "$latest" != "None" ]; then
      seen="$(digits_of "$latest")"
      if [ -n "$seen" ] && [ "$seen" -gt "$wanted" ]; then
        rehearsal_log "the latest restorable point $(to_utc_instant "$latest") is past the evidence at $evidence"
        return 0
      fi
      rehearsal_log "attempt $attempt of $RESTORABLE_WAIT_ATTEMPTS: the restorable point has not reached $evidence yet"
    else
      rehearsal_log "attempt $attempt of $RESTORABLE_WAIT_ATTEMPTS: ${PREFIX}-pg reports no LatestRestorableTime yet"
    fi
    sleep "$RESTORABLE_WAIT_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "FAIL: ${PREFIX}-pg's latest restorable point never passed the drill evidence written at $evidence." >&2
  echo "      Waited $RESTORABLE_WAIT_ATTEMPTS attempts of ${RESTORABLE_WAIT_SECONDS}s. A restore target that predates" >&2
  echo "      the evidence restores a database with nothing in it to reconstruct, which is the vacuous" >&2
  echo "      pass this drill exists to prevent; see docs/greenfield/restore-drill.md 0.1." >&2
  return 1
}

# ---------------------------------------------------------------------------
# The restore point, which RDS chooses and this drill reads rather than names.
#
# It used to be `now`: `--restore-time "$DRILL_START"` against an instant that was a
# second old. RDS restores to a point inside its own continuous backup window, and the
# latest restorable point lags real time by up to about five minutes (spec 4.1) — so
# `now` is an instant the source instance cannot be restored to, and the API refuses it
# with `InvalidRestoreTime`. The drill would have failed at step 1, after the guard, on
# the first credentialed run.
#
# So the restore asks for `--use-latest-restorable-time` and the *baseline* is measured
# at the instant RDS reports as that point, read from the source instance before the
# restore is requested. Every `--as-of`, every "restore point minus N" and the reported
# CRM recovery point are all relative to it.
#
# The read happens before the restore, so the real restorable point may have advanced a
# few seconds by the time RDS acts on it. That drift is in the safe direction and is
# the reason it is tolerated: the restored database then holds slightly *more* than the
# baseline counted, so "no suppression was lost" and "no send repeated" are asserted
# against a floor rather than against a moving target.
# ---------------------------------------------------------------------------
if [ -n "${FSS_RESTORE_TARGET:-}" ]; then
  # An operator naming the point by hand, which is also how the release suite drives
  # the shape guard offline.
  RESTORE_TARGET="$FSS_RESTORE_TARGET"
elif rehearsal_dry_run; then
  # Dry mode reaches no AWS, so there is no restorable point to read. The drill start
  # stands in for it and every instant below is derived from it exactly as it would be.
  RESTORE_TARGET="$DRILL_START"
  rehearsal_plan "wait until aws rds describe-db-instances reports a LatestRestorableTime past the asOf in $EVIDENCE_REPORT"
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg --query DBInstances[0].LatestRestorableTime"
else
  wait_for_restorable_point "$EVIDENCE_AT" || exit 1
  LATEST_RESTORABLE="$(rehearsal_aws rds describe-db-instances \
    --db-instance-identifier "${PREFIX}-pg" \
    --query 'DBInstances[0].LatestRestorableTime' --output text)"
  if [ -z "$LATEST_RESTORABLE" ] || [ "$LATEST_RESTORABLE" = "None" ]; then
    echo "FAIL: ${PREFIX}-pg reports no LatestRestorableTime, so there is no point to restore to." >&2
    echo "      A database with continuous backups disabled, or one created seconds ago, cannot" >&2
    echo "      be point-in-time restored and this drill cannot be run against it." >&2
    exit 1
  fi
  RESTORE_TARGET="$(to_utc_instant "$LATEST_RESTORABLE")"
  rehearsal_log "RDS reports the latest restorable point as $RESTORE_TARGET"
fi

# `minus` below hands the target to `date`, one branch of which is BSD's
# `date -j -f %Y-%m-%dT%H:%M:%SZ` and the other GNU's `date -d`. Both parse exactly this
# shape and neither says anything useful about another one: an operator who exported
# `FSS_RESTORE_TARGET=2026-09-21 00:00:00` gets a `date: illegal time format` from inside
# a command substitution and a drill that stopped for no stated reason. The format is
# therefore checked before it is used, and named in the refusal.
RESTORE_TARGET_SHAPE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
if [[ ! "$RESTORE_TARGET" =~ $RESTORE_TARGET_SHAPE ]]; then
  echo "FAIL: '$RESTORE_TARGET' is not an instant this drill can measure from." >&2
  echo "      FSS_RESTORE_TARGET must be YYYY-MM-DDTHH:MM:SSZ, which is what both the GNU" >&2
  echo "      and the BSD branch of the date arithmetic below parse, and what RDS reports as" >&2
  echo "      LatestRestorableTime once normalised." >&2
  exit 1
fi

rehearsal_log "drill start $DRILL_START, restore target $RESTORE_TARGET"

minus() { # minus <seconds>
  if date -u -d "@0" >/dev/null 2>&1; then
    date -u -d "$RESTORE_TARGET - $1 seconds" +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -j -v"-$1S" -f %Y-%m-%dT%H:%M:%SZ "$RESTORE_TARGET" +%Y-%m-%dT%H:%M:%SZ
  fi
}
REPLAY_FROM="$(minus 3600)"   # Appendix E.2: the restore point minus one hour.
SENT_FROM="$(minus 600)"      # Appendix E.3 and E.4: minus ten minutes.


drill_task() { # drill_task <step name> <kind> <capture file> <command word>...
  local step=$1 kind=$2 capture=$3
  shift 3
  FSS_RELEASE_CAPTURE="$capture" "$RUN_TASK" "$PREFIX" "$step" "$kind" -- "$@"
}

# ---------------------------------------------------------------------------
# Step 0. The baseline, and the refusal that makes the rest mean something.
#
# Measured on the **source** instance, before the restore, as of the instant RDS
# reported. It runs as a one-off task like everything else that touches PostgreSQL,
# and the answer comes back through the task's log stream rather than through a file:
# a Fargate task's filesystem goes away with the task.
# ---------------------------------------------------------------------------
rehearsal_log "step 0: the activity this drill has to reconstruct"
BASELINE="$REPORTS/baseline.json"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin counts --as-of $RESTORE_TARGET (in-VPC task, operations, against the source)"
  # A baseline the caller already placed is left alone, so the refusal below can be
  # exercised offline with a deliberately empty one. `test/release/scenario11.check.ts`
  # does exactly that, and the mutation check requires it to fail when the refusal is
  # removed — which is how "a drill against an empty database proves nothing" stops
  # being a comment and becomes a test.
  if [ ! -f "$BASELINE" ]; then
    cat > "$BASELINE" <<'JSON'
{"asOf":"2026-09-21T00:00:00Z","sends":1,"replies":1,"suppressions":1,"crm_edits":1,"migrations":1}
JSON
  fi
else
  drill_task baseline operations "$REPORTS/baseline.log" admin counts --as-of "$RESTORE_TARGET"
  release_captured_report "$REPORTS/baseline.log" "$BASELINE"
fi

for kind in sends replies suppressions crm_edits migrations; do
  count="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],0))" "$BASELINE" "$kind")"
  if [ "$count" -lt 1 ]; then
    echo "FAIL: the drill baseline has no $kind, so reconstructing them would prove nothing" >&2
    echo "      Appendix G 11 needs an accepted send, a reply, a suppression, a CRM edit and a migration" >&2
    exit 1
  fi
  rehearsal_log "baseline $kind=$count"
done

# ---------------------------------------------------------------------------
# Step 0b. The work the restore is meant to lose (0.1, lane g40).
#
# "Then let the clock run past it while more activity happens, so the restore genuinely
# loses work." The target has been read and the baseline measured at it; everything
# from here is after that instant. The after phase adds a second accepted send and a
# second ordinary CRM edit and nothing else — a second suppression or a second reply
# would change what steps 2 and 4 are reconstructing, and every assertion below is
# unchanged by this step because every one of them is a floor.
#
# It runs here rather than in the workflow because it has to sit between the baseline
# and the restore, and the workflow has no seam there. The root is named rather than
# taken as an argument: `rehearsal_require_prefix` above has already refused anything
# that is not a rehearsal run, so there is only one root this can be.
# ---------------------------------------------------------------------------
rehearsal_log "step 0b: the activity the restore has to lose"
SEED_EVIDENCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-seed-drill-evidence.sh"
if rehearsal_dry_run; then
  rehearsal_plan "$SEED_EVIDENCE infra/roots/rehearsal $PREFIX --worker-digest \$FSS_RELEASE_WORKER_DIGEST --phase after"
else
  "$SEED_EVIDENCE" infra/roots/rehearsal "$PREFIX" \
    --worker-digest "$FSS_RELEASE_WORKER_DIGEST" \
    --phase after
fi

# ---------------------------------------------------------------------------
# Step 1a. Restore. The runner's half of step 1: two RDS calls and a wait.
# ---------------------------------------------------------------------------
rehearsal_log "step 1: restore to a new instance"
# `--use-latest-restorable-time` rather than `--restore-time "$RESTORE_TARGET"`: the
# target above is what RDS *reported* as that point a moment ago, and asking for it by
# name would fail with `InvalidRestoreTime` the moment the window moved. The baseline
# was measured at the reported instant, which is the floor every assertion uses.
# Where the restored instance lives: the source instance's own subnet group, parameter
# group and security groups, read from the source rather than assumed. Left unnamed,
# RDS places a point-in-time restore in the VPC's *default* security group (API
# reference: "Default: The default EC2 VPC security group for the DB subnet group's
# VPC"), which this stack deliberately empties, and in the engine's default parameter
# group, which the deployment role is not allowed to name. The independent review of
# 22 September found both before the first drill did.
if rehearsal_dry_run; then
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg --query DBInstances[0].[DBSubnetGroup.DBSubnetGroupName,DBParameterGroups[0].DBParameterGroupName,join(',',VpcSecurityGroups[].VpcSecurityGroupId)]"
  SOURCE_SUBNET_GROUP="${PREFIX}-db"
  SOURCE_PARAMETER_GROUP="${PREFIX}-pg16"
  SOURCE_SECURITY_GROUPS="sg-0000000000000000e"
else
  read -r SOURCE_SUBNET_GROUP SOURCE_PARAMETER_GROUP SOURCE_SECURITY_GROUPS <<<"$(rehearsal_aws rds describe-db-instances \
    --db-instance-identifier "${PREFIX}-pg" \
    --query 'DBInstances[0].[DBSubnetGroup.DBSubnetGroupName,DBParameterGroups[0].DBParameterGroupName,join(`,`,VpcSecurityGroups[].VpcSecurityGroupId)]' --output text)"
  for value in "$SOURCE_SUBNET_GROUP" "$SOURCE_PARAMETER_GROUP" "$SOURCE_SECURITY_GROUPS"; do
    if [ -z "$value" ] || [ "$value" = "None" ]; then
      echo "FAIL: ${PREFIX}-pg did not report its subnet group, parameter group and security groups; the restore cannot be placed." >&2
      exit 1
    fi
  done
  rehearsal_log "restore placement: subnet group $SOURCE_SUBNET_GROUP, parameter group $SOURCE_PARAMETER_GROUP, security groups $SOURCE_SECURITY_GROUPS"
fi
rehearsal_aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "${PREFIX}-pg" \
  --target-db-instance-identifier "${PREFIX}-pg-restored" \
  --use-latest-restorable-time \
  --no-publicly-accessible \
  --db-subnet-group-name "$SOURCE_SUBNET_GROUP" \
  --db-parameter-group-name "$SOURCE_PARAMETER_GROUP" \
  --vpc-security-group-ids "$SOURCE_SECURITY_GROUPS"
rehearsal_aws rds wait db-instance-available --db-instance-identifier "${PREFIX}-pg-restored"

# The lag between the requested point and the actual one is one of the three numbers
# section 12 of the runbook asks every recurring drill to record, so it is read and
# logged rather than assumed. The endpoint is read in the same breath: it is a
# hostname, it is public, and it is the only thing about the restored instance that
# has to travel to the task (David's condition 4). The credential does not move at
# all — a point-in-time restore copies the roles and their passwords, so the same
# Secrets Manager entry still names the right user.
if rehearsal_dry_run; then
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg-restored --query DBInstances[0].[Endpoint.Address,InstanceCreateTime,LatestRestorableTime]"
  RESTORED_HOST="${PREFIX}-pg-restored.dryrun.us-east-1.rds.amazonaws.com"
else
  read -r RESTORED_HOST RESTORED_CREATED RESTORED_LATEST <<<"$(rehearsal_aws rds describe-db-instances \
    --db-instance-identifier "${PREFIX}-pg-restored" \
    --query 'DBInstances[0].[Endpoint.Address,InstanceCreateTime,LatestRestorableTime]' --output text)"
  rehearsal_log "restored instance instants: $RESTORED_CREATED $RESTORED_LATEST"
fi
rehearsal_refuse_production_arguments "$RESTORED_HOST"
export FSS_RESTORED_DATABASE_HOST="$RESTORED_HOST"
rehearsal_log "restored instance at $RESTORED_HOST"

# ---------------------------------------------------------------------------
# Steps 1b to 9. One in-VPC task, one correlated log, per-step JSON reports.
#
# `fss drill` runs them in one process against the restored instance: step 1's two
# assertions (a restore hold exists, a dial is refused), the journal replay twice, the
# Sent reconciliation, the inbox recovery, the job discard and rematerialisation, the
# watch renewal and coverage, the forward migration, the reconciliation report and the
# generation advance. It stops at the first step that fails and says which.
#
# One task rather than eight: they share a connection, a transactional view of a
# database that is being reconstructed underneath them, and a log stream — and eight
# tasks would each pay a minute of Fargate startup to hand the next one a database in
# a state it cannot describe.
#
# The dependency mode is **not** passed here. `infra/modules/cluster` fixes
# `FSS_DEPENDENCIES=recorded` on the drill task definition, because `reconcile-sent`,
# `recover` and `watch-renew` all reach Gmail when it is `live` and a mode a caller
# passes is a mode a caller can forget (David's condition 6).
# ---------------------------------------------------------------------------
rehearsal_log "steps 1 to 9: one in-VPC task against the restored instance"
DRILL_REPORT="$REPORTS/drill.json"
if rehearsal_dry_run; then
  rehearsal_plan "fss drill --reports /tmp/fss-drill --as-of $RESTORE_TARGET --from $REPLAY_FROM --since $SENT_FROM --all-mailboxes (in-VPC task, drill, FSS_DATABASE_HOST=$RESTORED_HOST)"
  cat > "$DRILL_REPORT" <<'JSON'
{
  "ok": true,
  "baselineAt": "2026-09-21T00:00:00Z",
  "stoppedAt": null,
  "steps": [
    { "step": "step1-restore-holds", "ok": true, "report": { "count": 1 } },
    { "step": "step1-dial-refused", "ok": true, "report": { "allowed": false } },
    { "step": "step2-journal-replay", "ok": true, "report": { "inserted": 1 } },
    { "step": "step2-journal-replay-second", "ok": true, "report": { "inserted": 0 } },
    { "step": "step3-reconcile-sent", "ok": true, "report": { "tombstones": 1, "resent": 0 } },
    { "step": "step4-inbox-recover", "ok": true, "report": { "replies": 1, "opt_outs": 1 } },
    { "step": "step5-jobs-discard", "ok": true, "report": { "discarded": 1 } },
    { "step": "step5-scheduler-run-once", "ok": true, "report": { "created": 1 } },
    { "step": "step6-watch-renew", "ok": true, "report": { "renewed": 1 } },
    { "step": "step6-coverage", "ok": true, "report": { "mailboxes": [{ "complete": true }] } },
    { "step": "step7-migrate", "ok": true, "report": { "schema": { "apiAccepts": true, "workerAccepts": true } } },
    { "step": "step8-restore-report", "ok": true, "report": { "suppressions_before": 1, "suppressions_after": 1, "sends_repeated": 0, "crm_rpo_seconds": 300, "unresolved": [] } },
    { "step": "step9-system-generation-advance", "ok": true, "report": { "holdsReleased": 1, "otherHoldsBefore": 1, "otherHoldsAfter": 1 } }
  ]
}
JSON
else
  drill_task drill drill "$REPORTS/drill.log" drill \
    --reports /tmp/fss-drill \
    --as-of "$RESTORE_TARGET" \
    --from "$REPLAY_FROM" \
    --since "$SENT_FROM" \
    --all-mailboxes
  release_captured_report "$REPORTS/drill.log" "$DRILL_REPORT"
fi

# ---------------------------------------------------------------------------
# The runner reads the report and decides whether it is a pass.
#
# The assertions stay here rather than moving into the tool: the tool reports what
# happened and the *release* decides whether that is a pass, so a change to the tool
# can never quietly relax the gate. Each per-step report is also written out under the
# name the release record and the workflow already look for, so the artifacts a
# release leaves behind are unchanged by where the work ran.
# ---------------------------------------------------------------------------
python3 - "$DRILL_REPORT" "$REPORTS" <<'PY'
import json, pathlib, sys

report = json.load(open(sys.argv[1]))
reports = pathlib.Path(sys.argv[2])

assert report.get("stoppedAt") is None, f"the drill stopped at {report.get('stoppedAt')}"
steps = {entry["step"]: entry for entry in report.get("steps", [])}

# A drill report with no steps in it would satisfy every assertion below by having
# nothing to disagree with, which is this check's own vacuous pass.
required = [
    "step1-restore-holds",
    "step1-dial-refused",
    "step2-journal-replay",
    "step2-journal-replay-second",
    "step3-reconcile-sent",
    "step4-inbox-recover",
    "step6-coverage",
    "step7-migrate",
    "step8-restore-report",
    "step9-system-generation-advance",
]
missing = [name for name in required if name not in steps]
assert not missing, f"the drill reported no {', '.join(missing)}"
failed = [name for name, entry in steps.items() if not entry.get("ok")]
assert not failed, f"the drill failed at {', '.join(failed)}"

def body(name):
    return steps[name].get("report") or {}

# The same names the release record and the workflow's own assertions read, so where
# the work ran is invisible to everything downstream.
for name, destination in [
    ("step2-journal-replay", "journal-replay.json"),
    ("step2-journal-replay-second", "journal-replay-second.json"),
    ("step3-reconcile-sent", "sent-reconcile.json"),
    ("step4-inbox-recover", "inbox-recover.json"),
    ("step6-coverage", "coverage.json"),
    ("step8-restore-report", "restore-report.json"),
    ("step9-system-generation-advance", "generation-advance.json"),
]:
    (reports / destination).write_text(json.dumps(body(name), indent=2) + "\n")

# Step 1: the generation mismatch held sending and dialing. Everything after it is
# meaningless if this was not true.
assert body("step1-restore-holds").get("count", 0) >= 1, "the restored database opened no restore hold"
assert body("step1-dial-refused").get("allowed") is False, "a dial was authorized while a restore was in progress"

# Step 2: the first replay must have done something, or the journal held nothing and
# the idempotence of the second run is the idempotence of doing nothing twice.
first, second = body("step2-journal-replay"), body("step2-journal-replay-second")
assert first.get("inserted", 0) >= 1, f"the journal replay reinserted nothing: {first}"
assert second.get("inserted", 0) == 0, f"the second replay was not idempotent: {second}"

# Steps 3 and 4.
sent = body("step3-reconcile-sent")
assert sent.get("resent", 0) == 0, f"a send repeated: {sent}"
assert sent.get("tombstones", 0) >= 1, f"no send was reconstructed, so nothing was proved: {sent}"
inbox = body("step4-inbox-recover")
assert inbox.get("replies", 0) >= 1, f"no reply reapplied its effect: {inbox}"
assert inbox.get("opt_outs", 0) >= 1, f"no opt-out reapplied: {inbox}"

# Step 6.
mailboxes = body("step6-coverage").get("mailboxes", [])
assert mailboxes, f"no mailbox reported coverage at all: {body('step6-coverage')}"
assert all(mailbox.get("complete") for mailbox in mailboxes), f"coverage is incomplete: {mailboxes}"

# Step 8: the two that fail the release outright (restore-drill.md section 11).
restore = body("step8-restore-report")
assert restore["sends_repeated"] == 0, f"a send repeated: {restore}"
assert restore["suppressions_after"] >= restore["suppressions_before"], f"a suppression was lost: {restore}"
# The accepted RPO is reported, never hidden. Absent is a failure; a number is not.
assert isinstance(restore.get("crm_rpo_seconds"), int), "the CRM recovery point objective was not reported"
print(f"CRM RPO reported as {restore['crm_rpo_seconds']}s")

# Step 9. 4.3: "Clearing one hold never clears another." A drill with no other holds
# cannot show that, so the absence of one is a failed setup rather than a pass.
advance = body("step9-system-generation-advance")
before_other = advance.get("otherHoldsBefore", 0)
assert before_other >= 1, f"no other hold existed, so selectivity was not tested: {advance}"
assert advance.get("otherHoldsAfter") == before_other, f"advancing the generation cleared unrelated holds: {advance}"
PY

# ---------------------------------------------------------------------------
# Step 7's control-plane half: the two images against the moved schema.
#
# `fss drill` reapplied the migrations and reported that both declared ranges accept
# the result. This is the part only ECS can answer, and it is the runner's.
# ---------------------------------------------------------------------------
rehearsal_log "step 7: the declared ranges, against the deployed images"
# The two digests travel in the environment — `FSS_RELEASE_API_DIGEST` and
# `FSS_RELEASE_WORKER_DIGEST`, checked above — exactly as they do for
# `rehearsal-run-task.sh`, so this call stays the prefix and nothing else.
"$(dirname "${BASH_SOURCE[0]}")/rehearsal-schema-ranges.sh" "$PREFIX"

rehearsal_write_report "restore-drill.txt" \
  "prefix=$PREFIX target=$RESTORE_TARGET restored_host=$RESTORED_HOST result=pass"
rehearsal_log "Appendix E steps 1 to 9 complete; Appendix G 11 passes"
