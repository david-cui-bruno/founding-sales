#!/usr/bin/env bash
# The safe-idle check before a schema release stops production, and the release drain
# (slice A4, C2B milestone).
#
#   infra/scripts/idle.sh check      <root> <prefix> [--environment production]
#   infra/scripts/idle.sh wait       <root> <prefix> [--environment production]
#   infra/scripts/idle.sh drain-on   <root> <prefix> --environment production [--minutes N]
#   infra/scripts/idle.sh drain-off  <root> <prefix> --environment production
#
# Each runs `fss admin release idle-check` or `fss admin release drain on|off` as a
# one-off task on the operations task definition (lib.sh release_run_task), held to that
# definition's own worker image, exactly as record.sh does for the release record.
#
#   check      one read; exit 0 idle, exit 3 busy (reasons printed), exit 1 could not tell.
#   wait       what stop.sh does first. Polls every FSS_PROD_IDLE_POLL_SECONDS (default 15)
#              for up to FSS_PROD_IDLE_WAIT_SECONDS (default 600), and returns the moment
#              the check says idle. Busy at the end: refuses in plain words, exit 1, and
#              has changed nothing. A rehearsal never waits longer than one poll.
#              FSS_PROD_FORCE_IDLE=1 skips the wait in production, says "forced", and
#              records it. An idle check that cannot be read is a refusal, never a pass.
#   drain-on   production's "nothing new starts" switch (default 20 minutes, at most 60);
#              it lapses by itself. stop.sh turns it on before the wait.
#   drain-off  turns it off; deploy.sh does this once the deployed verify passes, and
#              rollback.sh after its smoke. Turning it off when it is off is not an error.
#
# `wait` writes release-idle.txt in the reports directory:
#   root=... prefix=... environment=... result=idle|forced|refused|planned
#   idle_wait_seconds=N polls=N forced=0|1
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and waits for nothing.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

idle_usage() {
  echo "usage: idle.sh check|wait <root> <prefix> [--environment production]" >&2
  echo "       idle.sh drain-on <root> <prefix> --environment production [--minutes N]" >&2
  echo "       idle.sh drain-off <root> <prefix> --environment production" >&2
  exit 2
}

idle_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

IDLE_POLL_SECONDS=${FSS_PROD_IDLE_POLL_SECONDS:-15}
IDLE_WAIT_SECONDS=${FSS_PROD_IDLE_WAIT_SECONDS:-600}
IDLE_POLLS=0
IDLE_REASONS=''

# The worker image the operations definition runs, by digest; the task is held to it.
idle_operations_digest() {
  local definition digest
  definition="$(release_task_definition "$ENVIRONMENT" "$OPERATIONS_TASK_DEFINITION")"
  if [ -z "$definition" ]; then
    printf '%s' '<read-from-the-operations-definition>'
    return 0
  fi
  FSS_JSON="$definition" FSS_REPOSITORY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${PREFIX}-worker" python3 -c '
import json, os, re, sys
definition = json.loads(os.environ["FSS_JSON"]) or {}
image = next((str(entry.get("image", "")) for entry in definition.get("containerDefinitions") or [] if entry.get("name") == "operations"), "")
match = re.fullmatch(re.escape(os.environ["FSS_REPOSITORY"]) + r"@(sha256:[0-9a-f]{64})", image)
if not match:
    sys.exit("the operations task definition runs {!r}, which is not {} by digest".format(image, os.environ["FSS_REPOSITORY"]))
print(match.group(1))
' || idle_fail "the operations task definition is not the worker image by digest (above); nothing was asked."
}

# idle_task <step> <fss admin arguments...>: one operations task; its JSON answer lands
# in $reports/<step>.json (not in a dry run).
idle_task() {
  local step=$1 reports digest
  shift
  reports="$(rehearsal_report_dir)"
  mkdir -p "$reports"
  digest="$(idle_operations_digest)" || return 1
  rehearsal_log "$step: fss admin $*"
  release_run_task \
    --step "$step" --environment "$ENVIRONMENT" --prefix "$PREFIX" --account "$ACCOUNT" --region "$REGION" \
    --cluster "$CLUSTER_ARN" --task-definition "$OPERATIONS_TASK_DEFINITION" --container operations \
    --network-plan "$NETWORK_PLAN" --image-digest "$digest" \
    --database-host "$DATABASE_HOST" --secret-arn "$RUNTIME_SECRET_ARN" \
    --log-group "$LOG_GROUP" --log-stream-prefix operations --capture "$reports/$step.log" \
    -- admin "$@" || return 1
  if rehearsal_dry_run; then return 0; fi
  release_captured_report "$reports/$step.log" "$reports/$step.json" || return 1
}

# One read. Sets IDLE_REASONS; returns 0 idle, 3 busy, 1 unreadable.
idle_check_once() {
  local step verdict
  IDLE_POLLS=$((IDLE_POLLS + 1))
  step="release-idle-check-$IDLE_POLLS"
  IDLE_REASONS=''
  if rehearsal_dry_run; then
    idle_task "$step" release idle-check --report /tmp/fss-idle-check.json || return 1
    rehearsal_plan "read $(rehearsal_report_dir)/$step.json and proceed only when idle is true; a busy answer polls again every ${IDLE_POLL_SECONDS}s for up to ${IDLE_WAIT_SECONDS}s"
    return 0
  fi
  idle_task "$step" release idle-check --report /tmp/fss-idle-check.json \
    || { echo "FAIL: the idle check could not be run or read, so production is not known to be idle." >&2; return 1; }
  verdict="$(FSS_FILE="$(rehearsal_report_dir)/$step.json" python3 -c '
import json, os, sys
answer = json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}
if answer.get("idle") is True:
    print("idle|")
elif answer.get("idle") is False and isinstance(answer.get("reasons"), list):
    print("busy|" + "; ".join(str(reason) for reason in answer["reasons"]))
else:
    sys.exit(1)
')" || { echo "FAIL: the idle check's answer has no idle true or false: $(rehearsal_report_dir)/$step.json" >&2; return 1; }
  case "$verdict" in
    idle\|*) return 0 ;;
    busy\|*) IDLE_REASONS=${verdict#busy|}; return 3 ;;
  esac
  return 1
}

idle_write_report() { # idle_write_report <result> <waited seconds> <forced 0|1>
  rehearsal_write_report "release-idle.txt" \
    "root=$(release_canonical_path "$ROOT_DIRECTORY") prefix=$PREFIX environment=$ENVIRONMENT result=$1 idle_wait_seconds=$2 polls=$IDLE_POLLS forced=$3"
}

idle_wait() {
  local started waited=0 max_wait=$IDLE_WAIT_SECONDS status forced=0
  if [ "$ENVIRONMENT" != production ]; then
    # A rehearsal never waits longer than one poll: a check, at most one pause, one more check.
    max_wait=$IDLE_POLL_SECONDS
  fi
  if [ "${FSS_PROD_FORCE_IDLE:-0}" = 1 ] && [ "$ENVIRONMENT" = production ]; then
    forced=1
    rehearsal_log "FORCED: FSS_PROD_FORCE_IDLE=1, so the idle check is skipped and production is stopped whether or not anyone is on a call. This is recorded in the release timings."
    idle_write_report forced 0 1
    return 0
  fi
  started="$(date -u +%s)"
  while :; do
    status=0
    idle_check_once || status=$?
    waited=$(( $(date -u +%s) - started ))
    case "$status" in
      0)
        if rehearsal_dry_run; then
          idle_write_report planned 0 0
        else
          rehearsal_log "production is idle (checked $IDLE_POLLS time(s), waited ${waited}s)"
          idle_write_report idle "$waited" 0
        fi
        return 0
        ;;
      3) ;;
      *) idle_write_report refused "$waited" 0; return 1 ;;
    esac
    if [ "$waited" -ge "$max_wait" ]; then
      idle_write_report refused "$waited" 0
      echo "FAIL: production is not idle after ${waited}s ($IDLE_POLLS check(s)), so nothing was stopped: $IDLE_REASONS." >&2
      echo "      Wait until that is over and run this again. FSS_PROD_FORCE_IDLE=1 stops it anyway and records that it was forced." >&2
      return 1
    fi
    rehearsal_log "production is busy: $IDLE_REASONS. Checking again in ${IDLE_POLL_SECONDS}s (waited ${waited}s of ${max_wait}s)"
    sleep "$IDLE_POLL_SECONDS"
  done
}

idle_main() {
  local mode=${1:-} root=${2:-} prefix=${3:-} named='' minutes=''
  [ -n "$mode" ] && [ -n "$root" ] && [ -n "$prefix" ] || idle_usage
  shift 3
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --environment) named=${2:-}; shift; [ "$#" -gt 0 ] && shift ;;
      --minutes) minutes=${2:-}; shift; [ "$#" -gt 0 ] && shift ;;
      *) idle_fail "idle.sh does not take '$1'" ;;
    esac
  done
  [[ "$IDLE_POLL_SECONDS" =~ ^[0-9]+$ ]] || idle_fail "FSS_PROD_IDLE_POLL_SECONDS '$IDLE_POLL_SECONDS' is not a whole number of seconds"
  [[ "$IDLE_WAIT_SECONDS" =~ ^[0-9]+$ ]] || idle_fail "FSS_PROD_IDLE_WAIT_SECONDS '$IDLE_WAIT_SECONDS' is not a whole number of seconds"
  release_read_root "$root" "$prefix" "$named" "runs a one-off task on production's database"
  mkdir -p "$(rehearsal_report_dir)"
  release_guard_services "$mode"
  case "$mode" in
    check)
      local status=0
      idle_check_once || status=$?
      case "$status" in
        0) rehearsal_log "production is idle" ;;
        3) echo "BUSY: $IDLE_REASONS" >&2; exit 3 ;;
        *) exit 1 ;;
      esac
      ;;
    wait) idle_wait || exit 1 ;;
    drain-on)
      [ "$ENVIRONMENT" = production ] || idle_fail "the release drain is production's; a rehearsal does not use it"
      if [ -n "$minutes" ]; then
        [[ "$minutes" =~ ^[0-9]+$ ]] || idle_fail "--minutes takes a whole number of minutes from 1 to 60"
        idle_task release-drain-on release drain on --minutes "$minutes" --report /tmp/fss-drain.json || idle_fail "the release drain was not turned on"
      else
        idle_task release-drain-on release drain on --report /tmp/fss-drain.json || idle_fail "the release drain was not turned on"
      fi
      ;;
    drain-off)
      [ "$ENVIRONMENT" = production ] || idle_fail "the release drain is production's; a rehearsal does not use it"
      idle_task release-drain-off release drain off --report /tmp/fss-drain.json || idle_fail "the release drain was not turned off (it lapses by itself within 60 minutes)"
      ;;
    *) idle_usage ;;
  esac
}

idle_main "$@"
