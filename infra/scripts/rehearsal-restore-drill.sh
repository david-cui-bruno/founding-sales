#!/usr/bin/env bash
# Appendix E steps 1 to 9, and Appendix G 11.
#
#   infra/scripts/rehearsal-restore-drill.sh <fss-rh-run>
#
# `docs/greenfield/restore-drill.md` is the prose; this is the part CI runs. It follows
# the document step for step and adds the thing a document cannot: a refusal to report
# a pass when there was nothing to reconstruct.
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

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

# Everything below step 0 runs `fss admin ...`, and nothing in this repository
# installs an `fss` executable: no package declares a `bin`, and no step of
# `.github/workflows/greenfield-release.yml` puts one on PATH. A drill that discovered
# that at step 0 would already have been cheap; one that discovered it at step 2 would
# have created a restored RDS instance first. So it is a precondition, named, before
# anything is addressed. Dry mode reaches no `fss` at all and so does not need it.
if ! rehearsal_dry_run && ! command -v fss >/dev/null 2>&1; then
  echo "FAIL: the restore drill runs 'fss admin ...' and no fss executable is on PATH." >&2
  echo "      Nothing in this repository declares one (no package.json bin, no install step" >&2
  echo "      in the release workflow). See docs/greenfield/release.md section 8." >&2
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
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg --query DBInstances[0].LatestRestorableTime"
else
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

# ---------------------------------------------------------------------------
# Step 0. The baseline, and the refusal that makes the rest mean something.
# ---------------------------------------------------------------------------
rehearsal_log "step 0: the activity this drill has to reconstruct"
BASELINE="$REPORTS/baseline.json"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin counts --as-of $RESTORE_TARGET > $BASELINE"
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
  fss admin counts --as-of "$RESTORE_TARGET" > "$BASELINE"
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
# Step 1. Restore, and prove the generation mismatch holds sending and dialing.
# ---------------------------------------------------------------------------
rehearsal_log "step 1: restore to a new instance and confirm sending and dialing are held"
# `--use-latest-restorable-time` rather than `--restore-time "$RESTORE_TARGET"`: the
# target above is what RDS *reported* as that point a moment ago, and asking for it by
# name would fail with `InvalidRestoreTime` the moment the window moved. The baseline
# was measured at the reported instant, which is the floor every assertion uses.
rehearsal_aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "${PREFIX}-pg" \
  --target-db-instance-identifier "${PREFIX}-pg-restored" \
  --use-latest-restorable-time \
  --no-publicly-accessible
rehearsal_aws rds wait db-instance-available --db-instance-identifier "${PREFIX}-pg-restored"

# The lag between the requested point and the actual one is one of the three numbers
# section 12 of the runbook asks every recurring drill to record, so it is read and
# logged rather than assumed.
if rehearsal_dry_run; then
  rehearsal_plan "aws rds describe-db-instances --db-instance-identifier ${PREFIX}-pg-restored --query DBInstances[0].[InstanceCreateTime,LatestRestorableTime]"
else
  rehearsal_log "restored instance instants: $(rehearsal_aws rds describe-db-instances \
    --db-instance-identifier "${PREFIX}-pg-restored" \
    --query 'DBInstances[0].[InstanceCreateTime,LatestRestorableTime]' --output text)"
fi

if rehearsal_dry_run; then
  rehearsal_plan "fss admin holds list --reason restore_in_progress -> expect at least one"
  rehearsal_plan "fss admin dial-authorize --any -> expect refused"
else
  held="$(fss admin holds list --reason restore_in_progress --count)"
  if [ "$held" -lt 1 ]; then
    echo "FAIL: the restored database did not open a restore hold. Stop the drill and fail the release." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 2. Replay the suppression journal, and prove the replay is idempotent.
# ---------------------------------------------------------------------------
rehearsal_log "step 2: replay the suppression journal from $REPLAY_FROM"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin suppression-journal replay --from $REPLAY_FROM --report $REPORTS/journal-replay.json"
  rehearsal_plan "repeat it; the second run must insert 0"
  printf '{"inserted":1}\n' > "$REPORTS/journal-replay.json"
  printf '{"inserted":0}\n' > "$REPORTS/journal-replay-second.json"
else
  fss admin suppression-journal replay --from "$REPLAY_FROM" --report "$REPORTS/journal-replay.json"
  fss admin suppression-journal replay --from "$REPLAY_FROM" --report "$REPORTS/journal-replay-second.json"
fi
python3 - "$REPORTS/journal-replay.json" "$REPORTS/journal-replay-second.json" <<'PY'
import json, sys
first = json.load(open(sys.argv[1]))
second = json.load(open(sys.argv[2]))
# The first replay must have done something, or the journal held nothing and the
# idempotence of the second run is the idempotence of doing nothing twice.
assert first.get("inserted", 0) >= 1, f"the journal replay reinserted nothing: {first}"
assert second.get("inserted", 0) == 0, f"the second replay was not idempotent: {second}"
PY

# ---------------------------------------------------------------------------
# Step 3. Reconstruct sends from every Sent folder. No send may repeat.
# ---------------------------------------------------------------------------
rehearsal_log "step 3: reconcile the Sent folders from $SENT_FROM"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin mailbox reconcile-sent --since $SENT_FROM --all-mailboxes"
  printf '{"tombstones":1,"resent":0}\n' > "$REPORTS/sent-reconcile.json"
else
  fss admin mailbox reconcile-sent --since "$SENT_FROM" --all-mailboxes --report "$REPORTS/sent-reconcile.json"
fi
python3 - "$REPORTS/sent-reconcile.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report.get("resent", 0) == 0, f"a send repeated: {report}"
assert report.get("tombstones", 0) >= 1, f"no send was reconstructed, so nothing was proved: {report}"
PY

# ---------------------------------------------------------------------------
# Step 4. Reprocess every inbox so replies, opt-outs, direct sends and bounces reapply.
# ---------------------------------------------------------------------------
rehearsal_log "step 4: recover every inbox from $SENT_FROM"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin mailbox recover --since $SENT_FROM --all-mailboxes"
  printf '{"replies":1,"opt_outs":1,"direct_sends":0,"bounces":0}\n' > "$REPORTS/inbox-recover.json"
else
  fss admin mailbox recover --since "$SENT_FROM" --all-mailboxes --report "$REPORTS/inbox-recover.json"
fi
python3 - "$REPORTS/inbox-recover.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report.get("replies", 0) >= 1, f"no reply reapplied its effect: {report}"
assert report.get("opt_outs", 0) >= 1, f"no opt-out reapplied: {report}"
PY

# ---------------------------------------------------------------------------
# Steps 5 to 7. Job state, watches and migrations.
# ---------------------------------------------------------------------------
rehearsal_log "step 5: discard runnable job state and rematerialise it"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin jobs discard-runnable"
  rehearsal_plan "fss admin scheduler run-once"
else
  fss admin jobs discard-runnable --report "$REPORTS/jobs-discard.json"
  fss admin scheduler run-once --report "$REPORTS/jobs-rematerialise.json"
fi

rehearsal_log "step 6: renew every watch and prove coverage"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin mailbox watch-renew --all-mailboxes"
  rehearsal_plan "fss admin mailbox coverage --all-mailboxes -> every mailbox complete"
  printf '{"mailboxes":[{"complete":true}]}\n' > "$REPORTS/coverage.json"
else
  fss admin mailbox watch-renew --all-mailboxes --report "$REPORTS/watch-renew.json"
  fss admin mailbox coverage --all-mailboxes --report "$REPORTS/coverage.json"
fi
python3 - "$REPORTS/coverage.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
mailboxes = report.get("mailboxes", [])
assert mailboxes, f"no mailbox reported coverage at all: {report}"
assert all(m.get("complete") for m in mailboxes), f"coverage is incomplete: {report}"
PY

rehearsal_log "step 7: reapply migrations forward and check both declared ranges"
"$(dirname "${BASH_SOURCE[0]}")/rehearsal-schema-ranges.sh" "$PREFIX"

# ---------------------------------------------------------------------------
# Step 8. The reconciliation report.
# ---------------------------------------------------------------------------
rehearsal_log "step 8: reconciliation counts and unresolved exceptions"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin restore-report --out $REPORTS/restore-report.json"
  cat > "$REPORTS/restore-report.json" <<'JSON'
{"suppressions_before":1,"suppressions_after":1,"sends_repeated":0,"crm_rpo_seconds":300,"unresolved":[]}
JSON
else
  fss admin restore-report \
    --before "$BASELINE" \
    --journal "$REPORTS/journal-replay.json" \
    --sent "$REPORTS/sent-reconcile.json" \
    --inbox "$REPORTS/inbox-recover.json" \
    --out "$REPORTS/restore-report.json"
fi
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

# ---------------------------------------------------------------------------
# Step 9. An admin advances the generation; only the restore holds release.
# ---------------------------------------------------------------------------
rehearsal_log "step 9: advance the generation and prove the release was selective"
if rehearsal_dry_run; then
  rehearsal_plan "fss admin system-generation advance --report $REPORTS/restore-report.json"
  rehearsal_plan "fss admin holds list -> no restore_in_progress, every other hold still in force"
else
  before_other="$(fss admin holds list --exclude-reason restore_in_progress --count)"
  fss admin system-generation advance --report "$REPORTS/restore-report.json"
  after_restore="$(fss admin holds list --reason restore_in_progress --count)"
  after_other="$(fss admin holds list --exclude-reason restore_in_progress --count)"
  [ "$after_restore" -eq 0 ] || { echo "FAIL: a restore hold survived step 9" >&2; exit 1; }
  # 4.3: "Clearing one hold never clears another." A drill with no other holds cannot
  # show that, so the absence of one is a failed setup rather than a pass.
  [ "$before_other" -ge 1 ] || { echo "FAIL: no other hold existed, so selectivity was not tested" >&2; exit 1; }
  [ "$after_other" -eq "$before_other" ] || { echo "FAIL: advancing the generation cleared $((before_other - after_other)) unrelated holds" >&2; exit 1; }
fi

rehearsal_write_report "restore-drill.txt" "prefix=$PREFIX target=$RESTORE_TARGET result=pass"
rehearsal_log "Appendix E steps 1 to 9 complete; Appendix G 11 passes"
