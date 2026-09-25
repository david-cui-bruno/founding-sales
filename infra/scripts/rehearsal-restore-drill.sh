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
# reads the JSON answer out of it. For the same reason the source baseline goes *to*
# the drill task as a value in its command, `--baseline-json`, and never as a file
# (lane g53).
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
SEED_EVIDENCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-seed-drill-evidence.sh"

# ---------------------------------------------------------------------------
# Step 0a. The send left in doubt at the restore target (lane g59).
#
# Appendix E step 3 reconciles fences the restored database has in `dispatching` or
# `reconciling`, dispatched from the restore point minus ten minutes, against the Sent
# folder. The `before` phase's send reached `sent` in one pass half an hour earlier, so
# step 3 had nothing to reconcile. This phase dispatches one send through the real path
# with a recorded Gmail that delivers it and drops the response, so its fence is
# `reconciling` — and it runs here, just before the wait, so the restore target the wait
# produces is minutes after it: inside step 3's window, and early enough that the
# restored copy has the fence.
# ---------------------------------------------------------------------------
rehearsal_log "step 0a: the send left in doubt at the restore target"
if rehearsal_dry_run; then
  rehearsal_plan "$SEED_EVIDENCE infra/roots/rehearsal $PREFIX --worker-digest \$FSS_RELEASE_WORKER_DIGEST --phase in-flight"
else
  "$SEED_EVIDENCE" infra/roots/rehearsal "$PREFIX" \
    --worker-digest "$FSS_RELEASE_WORKER_DIGEST" \
    --phase in-flight
fi

# The newest evidence instant is the one the target must pass: the in-flight phase's
# when it ran, the before phase's for an operator drilling an environment by hand.
EVIDENCE_REPORT="$REPORTS/drill-evidence-before.txt"
if [ -f "$REPORTS/drill-evidence-in-flight.txt" ]; then
  EVIDENCE_REPORT="$REPORTS/drill-evidence-in-flight.txt"
fi
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
{"asOf":"2026-09-21T00:00:00Z","sends":1,"replies":1,"suppressions":1,"crm_edits":1,"migrations":1,"systemGeneration":1}
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

# The baseline travels to the drill task as a value (lane g53).
#
# The drill below runs against the *restored* instance, and "no suppression lost, no
# send repeated" means something only against the counts measured here, on the source,
# before the restore. A Fargate task's filesystem is created with it, there is no shared
# volume and the drill role has no S3, so the one thing that reaches the task is its
# command override: `fss drill --baseline-json '<json>'`, which the drill writes to its
# own `step0-baseline.json` and reads as step 8's `--before`. Until this lane the drill
# was launched with `--as-of` and re-measured step 0 on the restored copy.
#
# One line, because `release_run_task` reads the command words one per line; and only
# the instant and the five counts, because that is all the drill reads and it keeps the
# override the same size however many workspaces the rehearsal has. All six are public.
# A baseline with no instant is refused here, before a restored instance exists, rather
# than by the drill task after one does.
handed_baseline() { # handed_baseline <baseline file>
  python3 - "$1" <<'PY'
import json, sys

document = json.load(open(sys.argv[1]))
if not isinstance(document.get("asOf"), str) or not document["asOf"]:
    sys.exit(1)
kinds = ("asOf", "sends", "replies", "suppressions", "crm_edits", "migrations")
print(json.dumps({kind: document[kind] for kind in kinds if kind in document}, separators=(",", ":")))
PY
}
if ! BASELINE_JSON="$(handed_baseline "$BASELINE")"; then
  echo "FAIL: the drill baseline carries no asOf instant, so it cannot be handed to the drill task" >&2
  exit 1
fi
rehearsal_log "baseline handed to the drill task: $BASELINE_JSON"

# The generation the restored copy has to be held against (lane g56).
#
# A point-in-time copy carries its source's `system_generation`, and only step 9 ever
# moves one, so a restored database looks restored only to a check that expects a
# generation *ahead* of it. That is what an operator pins production to after a restore
# (`expected_system_generation`, docs/greenfield/release.md), and it is what the drill
# task is handed: the source's generation, measured with the baseline, plus one. Step 1a
# of the drill runs the worker's own startup check with it, which opens the restore
# holds and logs the line the immediately-critical alarm counts; after step 9 the
# database must be on exactly this generation. Refused here, before a restored instance
# exists, when the baseline does not carry it: an image older than lane g56 measured it.
expected_generation() { # expected_generation <baseline file>
  python3 - "$1" <<'PY'
import json, sys

generation = json.load(open(sys.argv[1])).get("systemGeneration")
if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
    sys.exit(1)
print(generation + 1)
PY
}
if ! EXPECTED_GENERATION="$(expected_generation "$BASELINE")"; then
  echo "FAIL: the drill baseline carries no systemGeneration, so the restored copy cannot be pinned against one" >&2
  echo "      fss admin counts reports it from lane g56 on; the drill passes it plus one as --expected-generation." >&2
  exit 1
fi
rehearsal_log "the restored copy is held against generation $EXPECTED_GENERATION (the source's plus one)"

# Who step 9's advance is attributed to (lane g59).
#
# Appendix E step 9 is "an authenticated admin advances system_generation", and the
# tool refuses to advance without one named (`admin_missing`). The drill task carries no
# identity of its own, and until lane g59 nothing named one, so step 9 could never have
# passed. The before phase's report names the workspace admin the seed acted as; an
# operator drilling by hand names one with FSS_DRILL_ADMIN_USER_ID. A public identifier,
# refused here if absent, before a restored instance exists.
ADMIN_USER_ID="${FSS_DRILL_ADMIN_USER_ID:-}"
if [ -z "$ADMIN_USER_ID" ] && [ -f "$REPORTS/drill-evidence-before.json" ]; then
  ADMIN_USER_ID="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("adminUserId") or "")' \
    "$REPORTS/drill-evidence-before.json")"
fi
if [ -z "$ADMIN_USER_ID" ]; then
  if rehearsal_dry_run; then
    ADMIN_USER_ID="dry-run-admin"
  else
    echo "FAIL: nothing names the admin step 9's generation advance is attributed to." >&2
    echo "      The before phase's report (drill-evidence-before.json) carries adminUserId; drilling by hand," >&2
    echo "      set FSS_DRILL_ADMIN_USER_ID to an active admin's user id." >&2
    exit 1
  fi
fi
rehearsal_log "step 9 will be attributed to admin $ADMIN_USER_ID"

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

# ---------------------------------------------------------------------------
# Step 0b. The work the restore is meant to lose (0.1; lanes g40 and g59).
#
# "Then let the clock run past it while more activity happens, so the restore genuinely
# loses work." It runs here, after the restore has been *requested*, and not between the
# baseline and the request as it did until lane g59: `--use-latest-restorable-time`
# restores to the latest point RDS has when it acts, which can be later than the target
# read above, so work written before the request may be restored rather than lost —
# and steps 2 and 4 now depend on it being lost. Nothing written after the request can
# be in a copy of a point that already existed when the request was made.
#
# The after phase adds a second accepted send, a second ordinary CRM edit, and a
# prospect's opt-out, journalled — the suppression step 2 replays and the message step 4
# recovers. Every assertion below is unchanged by it.
# ---------------------------------------------------------------------------
rehearsal_log "step 0b: the activity the restore has to lose"
if rehearsal_dry_run; then
  rehearsal_plan "$SEED_EVIDENCE infra/roots/rehearsal $PREFIX --worker-digest \$FSS_RELEASE_WORKER_DIGEST --phase after"
else
  "$SEED_EVIDENCE" infra/roots/rehearsal "$PREFIX" \
    --worker-digest "$FSS_RELEASE_WORKER_DIGEST" \
    --phase after
fi

# ---------------------------------------------------------------------------
# Step 0c. The counts at the moment of failure (restore-drill.md 0.1 and step 8).
#
# `fss admin counts > /tmp/at-failure.json` has stood in the runbook since G1, and step
# 8's `--at-failure` reads it; nothing wrote it until lane g59. The rehearsal's failure
# is the instant after the work the restore loses, so the counts are measured here, on
# the source, and handed to the drill as `--at-failure-json` the way the baseline is.
# Step 8 then measures "no suppression lost" against them: a suppression acknowledged
# after the target and before the failure is exactly what the journal must bring back.
# ---------------------------------------------------------------------------
rehearsal_log "step 0c: the counts at the moment of failure, on the source"
AT_FAILURE="$REPORTS/at-failure.json"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin counts (in-VPC task, operations, against the source, at the moment of failure)"
  if [ ! -f "$AT_FAILURE" ]; then
    printf '{"asOf":"%s","sends":2,"replies":2,"suppressions":3,"crm_edits":2,"migrations":1}\n' "$RESTORE_TARGET" > "$AT_FAILURE"
  fi
else
  drill_task at-failure operations "$REPORTS/at-failure.log" admin counts
  release_captured_report "$REPORTS/at-failure.log" "$AT_FAILURE"
fi
if ! AT_FAILURE_JSON="$(handed_baseline "$AT_FAILURE")"; then
  echo "FAIL: the counts at the moment of failure carry no asOf instant, so step 8 cannot measure against them" >&2
  exit 1
fi
rehearsal_log "at-failure counts handed to the drill task: $AT_FAILURE_JSON"

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
  RESTORED_HOST="${PREFIX}-pg-restored.dryrun.${AWS_REGION:-us-east-1}.rds.amazonaws.com"
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
# `fss drill` runs them in one process against the restored instance: step 1a's
# generation check, which opens the restore holds exactly as a worker pinned ahead of
# the restored copy would (lane g56), step 1's two assertions (a restore hold exists, a
# dial is refused), the journal replay twice, the Sent reconciliation, the inbox
# recovery, the job discard and rematerialisation, the watch renewal and coverage, the
# forward migration, the reconciliation report, the generation advance, and the check
# that the advance landed on the pin. It stops at the first step that fails and says
# which.
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

# What the rehearsal's recorded mailbox holds (lane g59).
#
# A recorded Gmail lives in the process that built it. Each seed phase reports its own
# mailbox — the Sent folder it delivered into, the inbound messages it delivered — and
# the drill task, being another process, can know the mailbox only from those reports:
# without them its Sent search finds nothing for step 3 to reconcile and its inbox holds
# nothing for step 4 to recover. So the three are merged here and handed over as
# `--mailbox-recording-json`, like the baseline. Nothing in it comes from the restored
# database and nothing in it is a credential; it is one line, because
# `release_run_task` reads the command one word per line.
merged_recording() { # merged_recording <reports directory>
  python3 - "$1" <<'PY'
import json, pathlib, sys

reports = pathlib.Path(sys.argv[1])
address, history, sent, messages = None, 1, set(), {}
for phase in ("before", "in-flight", "after"):
    path = reports / ("drill-evidence-%s.json" % phase)
    if not path.is_file():
        continue
    mailbox = json.load(open(path)).get("mailbox") or {}
    address = address or mailbox.get("emailAddress")
    history = max(history, int(mailbox.get("historyId") or 1))
    sent.update(mailbox.get("sentMessageIds") or [])
    for message in mailbox.get("messages") or []:
        messages[message["id"]] = message
recording = {"historyId": str(history), "sentMessageIds": sorted(sent), "messages": list(messages.values())}
if address:
    recording["emailAddress"] = address
print(json.dumps(recording, separators=(",", ":")))
PY
}
MAILBOX_RECORDING_JSON="$(merged_recording "$REPORTS")"
rehearsal_log "mailbox recording handed to the drill task: $(printf '%s' "$MAILBOX_RECORDING_JSON" | python3 -c 'import json, sys; r = json.load(sys.stdin); print("%d sent, %d messages" % (len(r["sentMessageIds"]), len(r["messages"])))')"

if rehearsal_dry_run; then
  rehearsal_plan "fss drill --reports /tmp/fss-drill --baseline-json $BASELINE_JSON --at-failure-json $AT_FAILURE_JSON --mailbox-recording-json $MAILBOX_RECORDING_JSON --expected-generation $EXPECTED_GENERATION --admin-user $ADMIN_USER_ID --from $REPLAY_FROM --since $SENT_FROM --all-mailboxes (in-VPC task, drill, FSS_DATABASE_HOST=$RESTORED_HOST)"
  # Unquoted, for the two generations only: the step 1a and step 9 reports carry the
  # pin this run handed over, as the real drill's do. Nothing else in it expands. A
  # report the caller already placed is left alone, as the baseline is, so
  # `test/release/scenario11.check.ts` can hand the runner a drill that stopped.
  OBSERVED_GENERATION=$((EXPECTED_GENERATION - 1))
  if [ ! -f "$DRILL_REPORT" ]; then
  cat > "$DRILL_REPORT" <<JSON
{
  "ok": true,
  "baselineAt": "2026-09-21T00:00:00Z",
  "stoppedAt": null,
  "unanswered": [],
  "steps": [
    { "step": "step1a-generation-check", "ok": true, "report": { "systemGeneration": ${OBSERVED_GENERATION}, "expectedGeneration": ${EXPECTED_GENERATION}, "mismatch": true, "holdsOpened": 1, "holdsAlreadyOpen": 0, "restoreHoldsInForce": 1 } },
    { "step": "step1-restore-holds", "ok": true, "report": { "count": 1 } },
    { "step": "step1-dial-refused", "ok": true, "report": { "allowed": false, "reason": "posture_missing", "holds": ["restore_in_progress"] } },
    { "step": "step2-journal-replay", "ok": true, "report": { "inserted": 1 } },
    { "step": "step2-journal-replay-second", "ok": true, "report": { "inserted": 0 } },
    { "step": "step3-reconcile-sent", "ok": true, "report": { "tombstones": 1, "resent": 0 } },
    { "step": "step4-inbox-recover", "ok": true, "report": { "replies": 1, "opt_outs": 1 } },
    { "step": "step5-jobs-discard", "ok": true, "report": { "discarded": 1 } },
    { "step": "step5-scheduler-run-once", "ok": true, "report": { "created": 1 } },
    { "step": "step6-watch-renew", "ok": true, "report": { "renewed": 1 } },
    { "step": "step6-coverage", "ok": true, "report": { "mailboxes": [{ "complete": true }] } },
    { "step": "step7-migrate", "ok": true, "report": { "schema": { "apiAccepts": true, "workerAccepts": true } } },
    { "step": "step8-restore-report", "ok": true, "report": { "suppressions_before": 1, "suppressions_at_failure": 3, "suppressions_after": 3, "sends_repeated": 0, "crm_rpo_seconds": 300, "crm_edits_lost": 1, "unresolved": [] } },
    { "step": "step9-system-generation-advance", "ok": true, "report": { "holdsReleased": 1, "otherHoldsBefore": 1, "otherHoldsAfter": 1 } },
    { "step": "step9-generation-reconciled", "ok": true, "report": { "generation": ${EXPECTED_GENERATION}, "expectedGeneration": ${EXPECTED_GENERATION}, "reconciled": true, "mismatch": false, "holdsOpened": 0, "restoreHoldsInForce": 0 } }
  ]
}
JSON
  fi
  # The capture the real launch leaves, with the one line the check below reads. A
  # capture the caller already placed is left alone, exactly as the baseline is, so
  # `test/release/scenario11.check.ts` can hand the runner one without it.
  if [ ! -f "$REPORTS/drill.log" ]; then
    printf '{"ts":"2026-09-21T00:10:00.000Z","level":"error","component":"fss","instance":"drill","event":"restore_generation_mismatch","expected_generation":%s,"observed_generation":%s,"restore_holds_opened":1,"restore_holds_already_open":0}\n' \
      "$EXPECTED_GENERATION" "$OBSERVED_GENERATION" > "$REPORTS/drill.log"
  fi
else
  # A drill that failed still prints its report (lane g59), so the task's refusal is
  # not the end of the step: the report is read, the alarm half of step 1 is read when
  # step 1a held the copy, and the verdict below names every step that failed. The
  # task's own status is kept and refused at the end whatever the verdict said.
  set +e
  drill_task drill drill "$REPORTS/drill.log" drill \
    --reports /tmp/fss-drill \
    --baseline-json "$BASELINE_JSON" \
    --at-failure-json "$AT_FAILURE_JSON" \
    --mailbox-recording-json "$MAILBOX_RECORDING_JSON" \
    --expected-generation "$EXPECTED_GENERATION" \
    --admin-user "$ADMIN_USER_ID" \
    --from "$REPLAY_FROM" \
    --since "$SENT_FROM" \
    --all-mailboxes
  DRILL_STATUS=$?
  set -e
  release_captured_report "$REPORTS/drill.log" "$DRILL_REPORT"
fi

# ---------------------------------------------------------------------------
# Step 1's alarm half (lane g56): "And the alarm must have fired."
#
# Read straight after the drill, and whenever step 1a passed, *before* the report is
# judged: a drill that held the restored copy and then stopped at a later step has
# still produced the mismatch, and a run that stops at step 1's dial probe (no
# dialable subject, release.md 8.0s) should still prove the alarm rather than exit
# before looking. When step 1a did not pass there is nothing to read, and the report
# below says why.
#
# Two assertions, because they fail for different reasons. The first reads the drill's
# own captured log stream: it must hold the `restore_generation_mismatch` line, the
# event `infra/modules/observability` turns into `RestoreGenerationMismatches`. The
# drill task writes to the worker log group, so that line is counted exactly as a
# worker's would be. The second reads the alarm. It is one datapoint of one at 60 s
# and treats missing data as not breaching, so by the end of a drill that ran for
# minutes its *current* state is normally OK again: what is asserted is its history,
# a transition to ALARM since the drill started, polled for as long as metric delivery
# and one evaluation can take.
# ---------------------------------------------------------------------------
step1a_passed() { # step1a_passed <drill report>
  python3 - "$1" <<'PY'
import json, sys

report = json.load(open(sys.argv[1]))
sys.exit(0 if any(entry.get("step") == "step1a-generation-check" and entry.get("ok") for entry in report.get("steps", [])) else 1)
PY
}

drill_logged_mismatch() { # drill_logged_mismatch <captured log>
  python3 - "$1" <<'PY'
import json, sys

found = False
for line in open(sys.argv[1], encoding="utf-8"):
    text = line.strip()
    if not text.startswith("{"):
        continue
    try:
        event = json.loads(text)
    except ValueError:
        continue
    if isinstance(event, dict) and event.get("event") == "restore_generation_mismatch" and event.get("level") == "error":
        found = True
sys.exit(0 if found else 1)
PY
}

alarm_went_to_alarm() { # alarm_went_to_alarm <describe-alarm-history JSON>
  FSS_HISTORY="$1" python3 -c '
import json, os, sys
history = json.loads(os.environ["FSS_HISTORY"] or "null") or {}
for item in history.get("AlarmHistoryItems") or []:
    try:
        data = json.loads(item.get("HistoryData") or "{}")
    except ValueError:
        continue
    if (data.get("newState") or {}).get("stateValue") == "ALARM":
        sys.exit(0)
sys.exit(1)
'
}

ALARM_NAME="${PREFIX}-restore-generation-mismatch"
ALARM_WAIT_ATTEMPTS=${FSS_ALARM_WAIT_ATTEMPTS:-20}
ALARM_WAIT_SECONDS=${FSS_ALARM_WAIT_SECONDS:-15}

if step1a_passed "$DRILL_REPORT"; then
  rehearsal_log "step 1: the mismatch reached the log group and the alarm"
  if ! drill_logged_mismatch "$REPORTS/drill.log"; then
    echo "FAIL: the drill logged no restore_generation_mismatch, so the immediately-critical alarm had nothing to count." >&2
    echo "      Its stream is kept in $REPORTS/drill.log; step 1a runs the check that writes it." >&2
    exit 1
  fi
  rehearsal_log "the drill's log stream holds restore_generation_mismatch"

  if [ "${FSS_RELEASE_ALARM_HISTORY+set}" = "set" ]; then
    # The answer handed in, which is how the release suite drives this offline.
    if ! alarm_went_to_alarm "$FSS_RELEASE_ALARM_HISTORY"; then
      echo "FAIL: $ALARM_NAME never went to ALARM after $DRILL_START." >&2
      exit 1
    fi
    rehearsal_log "$ALARM_NAME went to ALARM after $DRILL_START"
  elif rehearsal_dry_run; then
    rehearsal_plan "aws cloudwatch describe-alarm-history --alarm-name $ALARM_NAME --history-item-type StateUpdate --start-date $DRILL_START (until a transition to ALARM, $ALARM_WAIT_ATTEMPTS x ${ALARM_WAIT_SECONDS}s)"
  else
    attempt=1
    fired=0
    while [ "$attempt" -le "$ALARM_WAIT_ATTEMPTS" ]; do
      history="$(rehearsal_aws cloudwatch describe-alarm-history \
        --alarm-name "$ALARM_NAME" \
        --history-item-type StateUpdate \
        --start-date "$DRILL_START" \
        --output json)"
      if alarm_went_to_alarm "$history"; then
        fired=1
        break
      fi
      rehearsal_log "attempt $attempt of $ALARM_WAIT_ATTEMPTS: $ALARM_NAME has not gone to ALARM since $DRILL_START yet"
      sleep "$ALARM_WAIT_SECONDS"
      attempt=$((attempt + 1))
    done
    if [ "$fired" -ne 1 ]; then
      echo "FAIL: $ALARM_NAME never went to ALARM after $DRILL_START, though the drill logged the mismatch." >&2
      echo "      Read the metric filter (infra/modules/observability) and the alarm (infra/modules/alerts) against" >&2
      echo "      the environment's namespace; docs/greenfield/restore-drill.md step 1." >&2
      exit 1
    fi
    rehearsal_log "$ALARM_NAME went to ALARM after $DRILL_START"
  fi
else
  rehearsal_log "step 1a did not pass, so the mismatch line and the alarm are not read; the report below says why"
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
python3 - "$DRILL_REPORT" "$REPORTS" "$EXPECTED_GENERATION" <<'PY'
import json, pathlib, sys

report = json.load(open(sys.argv[1]))
reports = pathlib.Path(sys.argv[2])
expected_generation = int(sys.argv[3])

# Every step, as the drill saw it, before any verdict (lane g59): a run that fails
# should say how far it got, and past an unanswered step that is every step.
for entry in report.get("steps", []):
    verdict = "ok" if entry.get("ok") else ("UNANSWERED" if entry.get("unanswered") else "FAILED")
    print(f"  {entry.get('step')}: {verdict}" + ("" if entry.get("ok") else f" - {entry.get('failure')}"))

assert report.get("stoppedAt") is None, f"the drill stopped at {report.get('stoppedAt')}"
# Ran to the end is not passed: a step that could not be answered is a failed step, and
# the drill says which prerequisite it lacked (lane g59).
unanswered = report.get("unanswered") or []
assert not unanswered, f"the drill could not answer {', '.join(unanswered)}, so it is not a pass"
steps = {entry["step"]: entry for entry in report.get("steps", [])}

# A drill report with no steps in it would satisfy every assertion below by having
# nothing to disagree with, which is this check's own vacuous pass.
required = [
    "step1a-generation-check",
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
    "step9-generation-reconciled",
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
# meaningless if this was not true. Step 1a is what held it (lane g56): the worker's own
# startup check, run with the pin this runner handed over, against the restored copy.
check = body("step1a-generation-check")
assert check.get("expectedGeneration") == expected_generation, f"the generation check ran against another pin: {check}"
assert check.get("mismatch") is True, f"the generation check found no mismatch: {check}"
assert check.get("restoreHoldsInForce", 0) >= 1, f"the generation check held no workspace: {check}"
assert body("step1-restore-holds").get("count", 0) >= 1, "the restored database opened no restore hold"
dial = body("step1-dial-refused")
assert dial.get("allowed") is False, "a dial was authorized while a restore was in progress"
# Lane g60: refused because of the restore. `authorizeDial` stops at its first refusal
# and the restore hold is its eighth step, so a probe refused `posture_missing` or
# `outside_calling_window` proves nothing about the restore unless the restore hold is
# among the holds that apply to that same dial, which the probe reports beside it.
assert "restore_in_progress" in (dial.get("holds") or []), f"the dial was refused ({dial.get('reason')}) but no restore hold applied to it, so the refusal says nothing about the restore: {dial}"

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
# And against the moment of failure, which this runner always hands over (lane g59): a
# report without it is a drill that ignored --at-failure-json.
assert "suppressions_at_failure" in restore, f"the report was not measured against the moment of failure: {restore}"
assert restore["suppressions_after"] >= restore["suppressions_at_failure"], f"a suppression acknowledged before the failure was lost: {restore}"
# The accepted RPO is reported, never hidden. Absent is a failure; a number is not.
assert isinstance(restore.get("crm_rpo_seconds"), int), "the CRM recovery point objective was not reported"
print(f"CRM RPO reported as {restore['crm_rpo_seconds']}s")

# Step 9. 4.3: "Clearing one hold never clears another." A drill with no other holds
# cannot show that, so the absence of one is a failed setup rather than a pass.
advance = body("step9-system-generation-advance")
before_other = advance.get("otherHoldsBefore", 0)
assert before_other >= 1, f"no other hold existed, so selectivity was not tested: {advance}"
assert advance.get("otherHoldsAfter") == before_other, f"advancing the generation cleared unrelated holds: {advance}"

# Step 9's consequence (lane g56): the database is now on the pin, so a worker restarted
# with it holds nothing. This is the steady state production is left in after a restore.
reconciled = body("step9-generation-reconciled")
assert reconciled.get("generation") == expected_generation, f"step 9 did not land on the pinned generation {expected_generation}: {reconciled}"
assert reconciled.get("mismatch") is False and reconciled.get("holdsOpened") == 0, f"the pinned check still found a restore after step 9: {reconciled}"
assert reconciled.get("restoreHoldsInForce") == 0, f"a restore hold is in force after step 9: {reconciled}"
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

# The task's own verdict, whatever the report said (lane g59). A drill that exits
# non-zero has refused something, and a report that reads as a pass beside that refusal
# is a report this runner cannot vouch for.
if [ "${DRILL_STATUS:-0}" -ne 0 ]; then
  echo "FAIL: the drill task did not exit 0, though its report reads as a pass; see $REPORTS/drill.log." >&2
  exit 1
fi

rehearsal_write_report "restore-drill.txt" \
  "prefix=$PREFIX target=$RESTORE_TARGET restored_host=$RESTORED_HOST expected_generation=$EXPECTED_GENERATION result=pass"
rehearsal_log "Appendix E steps 1 to 9 complete; Appendix G 11 passes"
