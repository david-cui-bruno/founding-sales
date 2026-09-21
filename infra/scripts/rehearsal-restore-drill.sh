#!/usr/bin/env bash
# Appendix E steps 1 to 9, and Appendix G 11.
#
#   infra/scripts/rehearsal-restore-drill.sh <fss-rh-run>
#
# `docs/greenfield/restore-drill.md` is the prose; this is the part CI runs. It follows
# the document step for step and adds the thing a document cannot: a refusal to report
# a pass when there was nothing to reconstruct.
#
# ## Where each step runs (G12h, David's decision of 21 September)
#
# The rehearsal database is private — `publicly_accessible = false`, no NAT gateway,
# no interface endpoint — so a GitHub runner cannot reach it and no step that talks to
# PostgreSQL can run here. The division is:
#
#   * **the runner keeps the control plane**: the point-in-time restore, waiting for
#     the instance, the snapshot handling and the teardown. Those are AWS API calls
#     and the runner is the right place for them.
#   * **one in-VPC task runs the database steps**: `fss drill --from 2 --to 9`, as a
#     single ECS task on the worker image, so steps 2 to 9 share one connection, one
#     correlated log stream and one transactional view of the restored instance —
#     rather than eight tasks each paying a minute of startup and each able to
#     succeed while the next one fails for a reason the first would have caught.
#   * step 1's two assertions (a restore hold exists; dialing is refused) are the
#     same command with `--from 1 --to 1`, run the moment the instance is available,
#     because "the generation mismatch held sending" is the claim that has to be true
#     *before* anything is reconstructed.
#
# ## The restored instance
#
# The endpoint is a new hostname and the credentials are the old ones: a point-in-time
# restore copies the roles and their passwords. So the endpoint travels to the task as
# the `FSS_DATABASE_HOST` environment override — a public identifier, safe in
# `describe-tasks` — and the credential stays a Secrets Manager reference the
# execution role resolves. Nothing about the restored instance is ever an argument or
# a log line.
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

# Every database step goes through the wrapper, and the wrapper refuses to launch
# without the release's worker digest. That is the release gate at the moment of use:
# a drill that reconstructed a restored database with last release's image would pass
# and prove nothing about this one.
if ! rehearsal_dry_run && [ -z "${FSS_RELEASE_WORKER_DIGEST:-}" ]; then
  echo "FAIL: FSS_RELEASE_WORKER_DIGEST is not set, so the drill cannot launch a task whose image it can check." >&2
  echo "      The release workflow passes the dispatched worker digest; see docs/greenfield/release.md section 3." >&2
  exit 1
fi

# The instants every "restore point minus N" is measured from. Recorded, never guessed.
DRILL_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# `--use-latest-restorable-time` rather than an instant, unless the operator names one.
#
# RDS refuses a `--restore-time` later than `LatestRestorableTime`, which trails the
# present by several minutes, and the drill used to default the target to *now* — so
# the first run to reach step 1 would have been told `InvalidRestoreTime` (release.md
# 8.1, item 3). The baseline must then be counted as of the instant RDS actually
# restored to, not as of the instant this script started, so the restored instance is
# asked for its `LatestRestorableTime` and that is what step 0 counts against.
RESTORE_TARGET="${FSS_RESTORE_TARGET:-}"
RESTORE_TARGET_SHAPE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
if [ -n "$RESTORE_TARGET" ] && [[ ! "$RESTORE_TARGET" =~ $RESTORE_TARGET_SHAPE ]]; then
  echo "FAIL: '$RESTORE_TARGET' is not an instant this drill can measure from." >&2
  echo "      FSS_RESTORE_TARGET must be YYYY-MM-DDTHH:MM:SSZ, which is what both the GNU" >&2
  echo "      and the BSD branch of the date arithmetic below parse, and what RDS's" >&2
  echo "      --restore-time takes." >&2
  exit 1
fi

rehearsal_log "drill start $DRILL_START, restore target ${RESTORE_TARGET:-<latest restorable time>}"

# ---------------------------------------------------------------------------
# Step 1a. Restore. The runner's half: an RDS API call and a wait.
# ---------------------------------------------------------------------------
rehearsal_log "step 1: restore to a new instance"
if [ -n "$RESTORE_TARGET" ]; then
  rehearsal_aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier "${PREFIX}-pg" \
    --target-db-instance-identifier "${PREFIX}-pg-restored" \
    --restore-time "$RESTORE_TARGET" \
    --no-publicly-accessible
else
  rehearsal_aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier "${PREFIX}-pg" \
    --target-db-instance-identifier "${PREFIX}-pg-restored" \
    --use-latest-restorable-time \
    --no-publicly-accessible
fi
rehearsal_aws rds wait db-instance-available --db-instance-identifier "${PREFIX}-pg-restored"

# The restored endpoint, and the instant it actually restored to. Both public.
if rehearsal_dry_run; then
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg-restored -> Endpoint.Address, LatestRestorableTime"
  RESTORED_HOST="${PREFIX}-pg-restored.dryrun.us-east-1.rds.amazonaws.com"
  RESTORE_TARGET="${RESTORE_TARGET:-$DRILL_START}"
else
  RESTORED_HOST="$(command "$(rehearsal_aws_command)" rds describe-db-instances \
    --db-instance-identifier "${PREFIX}-pg-restored" \
    --query 'DBInstances[0].Endpoint.Address' --output text)"
  if [ -z "$RESTORE_TARGET" ]; then
    RESTORE_TARGET="$(command "$(rehearsal_aws_command)" rds describe-db-instances \
      --db-instance-identifier "${PREFIX}-pg" \
      --query 'DBInstances[0].LatestRestorableTime' --output text | cut -c1-19)Z"
  fi
fi
rehearsal_refuse_production_arguments "$RESTORED_HOST"
export FSS_RESTORED_DATABASE_HOST="$RESTORED_HOST"
rehearsal_log "restored instance at $RESTORED_HOST, restore point $RESTORE_TARGET"

minus() { # minus <seconds>
  if date -u -d "@0" >/dev/null 2>&1; then
    date -u -d "$RESTORE_TARGET - $1 seconds" +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -j -v"-$1S" -f %Y-%m-%dT%H:%M:%SZ "$RESTORE_TARGET" +%Y-%m-%dT%H:%M:%SZ
  fi
}
REPLAY_FROM="$(minus 3600)"   # Appendix E.2: the restore point minus one hour.
SENT_FROM="$(minus 600)"      # Appendix E.3 and E.4: minus ten minutes.

drill_task() { # drill_task <step name> <command word>...
  local step=$1
  shift
  "$RUN_TASK" "$PREFIX" "$step" operations -- "$@"
}

# ---------------------------------------------------------------------------
# Step 0. The baseline, and the refusal that makes the rest mean something.
#
# Counted against the *source* instance as of the restore point, before anything is
# reconstructed, so the comparison in step 8 is a comparison.
# ---------------------------------------------------------------------------
rehearsal_log "step 0: the activity this drill has to reconstruct"
BASELINE="$REPORTS/baseline.json"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin counts --as-of $RESTORE_TARGET > $BASELINE (in-VPC task, operations)"
  # A baseline the caller already placed is left alone, so the refusal below can be
  # exercised offline with a deliberately empty one. `test/release/scenario11.check.ts`
  # does exactly that, and the mutation check requires it to fail when the refusal is
  # removed — which is how "a drill against an empty database proves nothing" stops
  # being a comment and becomes a test.
  if [ ! -f "$BASELINE" ]; then
    cat > "$BASELINE" <<'JSON'
{"sends":1,"replies":1,"suppressions":1,"crm_edits":1,"migrations":1}
JSON
  fi
else
  # The baseline reads the *source*, so this one task is the exception that does not
  # carry the restored host.
  FSS_RESTORED_DATABASE_HOST='' "$RUN_TASK" "$PREFIX" baseline operations \
    -- admin counts --as-of "$RESTORE_TARGET" --report "$BASELINE"
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
# Step 1b. The generation mismatch holds sending and dialing.
#
# Asserted on the restored instance the moment it is available and before anything is
# replayed: if the holds were not there, everything after this would be running
# against a database that could send.
# ---------------------------------------------------------------------------
rehearsal_log "step 1: confirm sending and dialing are held on the restored instance"
if rehearsal_dry_run; then
  rehearsal_plan "fss drill --from 1 --to 1 -> a restore hold exists and dial-authorize is refused (in-VPC task)"
  printf '{"steps":[{"step":1,"ok":true,"holds":1,"dial":"refused"}]}\n' > "$REPORTS/drill-step1.json"
else
  drill_task drill-step-1 drill --from 1 --to 1 --report "$REPORTS/drill-step1.json"
fi

# ---------------------------------------------------------------------------
# Steps 2 to 9. One task, one log, per-step JSON, stopping at the first failure.
#
# `fss drill` fixes the dependency mode per step rather than taking one for the whole
# run: anything that could reach Gmail (reconcile-sent, recover, watch-renew) is
# `recorded`, the journal replay reads this run's journal bucket and nothing else, and
# the rest touch only PostgreSQL. `apps/worker/test/fssDrill.test.ts` asserts that
# table, because a drill that quietly ran a mail step `live` would be a rehearsal
# sending real mail.
# ---------------------------------------------------------------------------
rehearsal_log "steps 2 to 9: one in-VPC task against the restored instance"
if rehearsal_dry_run; then
  rehearsal_plan "fss drill --from 2 --to 9 --replay-from $REPLAY_FROM --sent-from $SENT_FROM --baseline $BASELINE --report-dir $REPORTS (in-VPC task, operations)"
  rehearsal_plan "  step 2 journal replay, twice; the second must insert 0"
  rehearsal_plan "  step 3 reconcile every Sent folder; no send may repeat"
  rehearsal_plan "  step 4 recover every inbox; replies and opt-outs reapply"
  rehearsal_plan "  step 5 discard runnable jobs and rematerialise"
  rehearsal_plan "  step 6 renew every watch and prove coverage"
  rehearsal_plan "  step 7 the schema version on the restored instance"
  rehearsal_plan "  step 8 the reconciliation report"
  rehearsal_plan "  step 9 advance the generation; only the restore holds release"
  printf '{"inserted":1}\n' > "$REPORTS/journal-replay.json"
  printf '{"inserted":0}\n' > "$REPORTS/journal-replay-second.json"
  printf '{"tombstones":1,"resent":0}\n' > "$REPORTS/sent-reconcile.json"
  printf '{"replies":1,"opt_outs":1,"direct_sends":0,"bounces":0}\n' > "$REPORTS/inbox-recover.json"
  printf '{"mailboxes":[{"complete":true}]}\n' > "$REPORTS/coverage.json"
  cat > "$REPORTS/restore-report.json" <<'JSON'
{"suppressions_before":1,"suppressions_after":1,"sends_repeated":0,"crm_rpo_seconds":300,"unresolved":[]}
JSON
  printf '{"before_other":1,"after_other":1,"after_restore":0}\n' > "$REPORTS/generation-advance.json"
else
  drill_task drill-steps-2-9 drill \
    --from 2 --to 9 \
    --replay-from "$REPLAY_FROM" \
    --sent-from "$SENT_FROM" \
    --baseline "$BASELINE" \
    --report-dir "$REPORTS"
fi

# ---------------------------------------------------------------------------
# The runner reads the reports the task wrote.
#
# The assertions stay here rather than moving into the tool: the tool reports what
# happened and the release decides whether that is a pass, so a change to the tool
# cannot quietly relax the gate.
# ---------------------------------------------------------------------------
python3 - "$REPORTS/journal-replay.json" "$REPORTS/journal-replay-second.json" <<'PY'
import json, sys
first = json.load(open(sys.argv[1]))
second = json.load(open(sys.argv[2]))
# The first replay must have done something, or the journal held nothing and the
# idempotence of the second run is the idempotence of doing nothing twice.
assert first.get("inserted", 0) >= 1, f"the journal replay reinserted nothing: {first}"
assert second.get("inserted", 0) == 0, f"the second replay was not idempotent: {second}"
PY

python3 - "$REPORTS/sent-reconcile.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report.get("resent", 0) == 0, f"a send repeated: {report}"
assert report.get("tombstones", 0) >= 1, f"no send was reconstructed, so nothing was proved: {report}"
PY

python3 - "$REPORTS/inbox-recover.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report.get("replies", 0) >= 1, f"no reply reapplied its effect: {report}"
assert report.get("opt_outs", 0) >= 1, f"no opt-out reapplied: {report}"
PY

python3 - "$REPORTS/coverage.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
mailboxes = report.get("mailboxes", [])
assert mailboxes, f"no mailbox reported coverage at all: {report}"
assert all(m.get("complete") for m in mailboxes), f"coverage is incomplete: {report}"
PY

python3 - "$REPORTS/restore-report.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
# The two that fail the release outright (restore-drill.md section 11).
assert report["sends_repeated"] == 0, f"a send repeated: {report}"
assert report["suppressions_after"] >= report["suppressions_before"], f"a suppression was lost: {report}"
# The accepted RPO is reported, never hidden. Absent is a failure; a number is not.
assert isinstance(report.get("crm_rpo_seconds"), int), "the CRM recovery point objective was not reported"
print(f"CRM RPO reported as {report['crm_rpo_seconds']}s")
PY

# 4.3: "Clearing one hold never clears another." A drill with no other holds cannot
# show that, so the absence of one is a failed setup rather than a pass.
python3 - "$REPORTS/generation-advance.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["after_restore"] == 0, f"a restore hold survived step 9: {report}"
assert report["before_other"] >= 1, f"no other hold existed, so selectivity was not tested: {report}"
assert report["after_other"] == report["before_other"], f"advancing the generation cleared unrelated holds: {report}"
PY

# ---------------------------------------------------------------------------
# Step 7's control-plane half: the two services against the moved schema.
#
# `fss drill` reported the restored instance's schema version; this is the part only
# ECS can answer, and it is the runner's.
# ---------------------------------------------------------------------------
rehearsal_log "step 7: the declared ranges, against the deployed images"
"$(dirname "${BASH_SOURCE[0]}")/rehearsal-schema-ranges.sh" "$PREFIX"

rehearsal_write_report "restore-drill.txt" \
  "prefix=$PREFIX target=$RESTORE_TARGET restored_host=$RESTORED_HOST result=pass"
rehearsal_log "Appendix E steps 1 to 9 complete; Appendix G 11 passes"
