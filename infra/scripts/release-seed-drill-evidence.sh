#!/usr/bin/env bash
# The activity the restore drill has to reconstruct (lane g40).
#
#   infra/scripts/release-seed-drill-evidence.sh <root> <prefix> \
#       --worker-digest D --phase before|in-flight|after [--workspace-slug S]
#
#   infra/scripts/release-seed-drill-evidence.sh infra/roots/rehearsal fss-rh-0923 \
#       --worker-digest "$digest" --phase before --workspace-slug rehearsal
#
# ## Why a deployed rehearsal needs this step at all
#
# `docs/greenfield/restore-drill.md` section 0.1 lists what must exist before the
# restore target is read: an accepted send, a prospect reply, a prospect-originated
# opt-out, a salesperson's own manual suppression inside its ten-minute window, an
# ordinary CRM edit and an applied migration. Nothing in this repository could produce
# any of the first five in a deployed environment, so `rehearsal-restore-drill.sh`
# refused — correctly, and every time:
#
#   FAIL: the drill baseline has no sends, so reconstructing them would prove nothing
#
# That is how the ninth full run (35930664547, 23 September 2026) ended: create, fill,
# the deploy path, the workspace bootstrap, the schema-range refusals, the production
# smoke and the release suite all passed for the first time, and step 22 stopped after
# 67 seconds on a baseline that could never have been anything but empty.
#
# ## Production is never seeded, and this script has no way to say otherwise
#
# `release-bootstrap-workspace.sh` runs in both environments and asks for
# `--environment production` to prove the operator meant it. This one does not run in
# production at all: production's drill (runbook section 7) reconstructs a
# salesperson's real sends, replies and suppressions, and seeding it would replace the
# thing being proved with a fixture. So the guard is `rehearsal_require_prefix`, the
# same one `rehearsal-restore-drill.sh` and `rehearsal-run-task.sh` use — a prefix that
# is not `fss-rh-<run>` is refused before anything is addressed, and there is no flag
# that relaxes it. The tool refuses a second time from inside the container, on
# `FSS_DEPENDENCIES`, because two guards that do not depend on each other is the
# arrangement that survives one of them being edited.
#
# ## The three phases (lane g59 added the middle one and changed the last)
#
# `--phase before` runs between the workspace bootstrap and the schema ranges, and
# writes everything 0.1 lists, plus what the drill's later steps need to find in the
# restored copy: the firm whose opt-out arrives later, a phone route, and an
# administrative pause.
#
# `--phase in-flight` runs from inside the drill, just before it reads the restore
# target: one send Gmail delivered and whose response never came back, so its fence is
# `reconciling` at the target and Appendix E step 3 has a fence the Sent folder proves.
#
# `--phase after` runs from inside the drill once the restore has been *requested* —
# 0.1's "then let the clock run past it while more activity happens, so the restore
# genuinely loses work". Only work written after the request is certain to be lost:
# `--use-latest-restorable-time` restores to whatever point RDS has when it acts. It
# adds a second accepted send, a second CRM edit, and a prospect's opt-out, journalled —
# which is what steps 2 and 4 reconstruct. (Until lane g59 it added the send and the
# edit only, so the replay and the recovery had nothing the restore had lost.)
#
# The report it writes carries `asOf=`, the instant the tool measured its counts at.
# `rehearsal-restore-drill.sh` waits until RDS reports a `LatestRestorableTime` later
# than the newest such instant before it reads the restore target, because the backup
# window lags real time by up to about five minutes and a target that predated the
# evidence would restore to a database without it. The JSON report beside it also
# carries what the phase's recorded mailbox holds (`mailbox`) and the workspace admin
# (`adminUserId`), which the drill script hands to `fss drill`.
#
# ## What it prints, and where the answer comes from
#
# A one-off Fargate task's filesystem goes away with the task, so `--report` inside the
# container cannot be read afterwards. What survives is the log stream: the tool prints
# one JSON object on stdout and every log line on stderr, and `release_captured_report`
# takes the object back out of the capture.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

WORKER_DIGEST=''
PHASE=''
WORKSPACE_SLUG='rehearsal'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    --phase) PHASE=$2; shift 2 ;;
    --workspace-slug) WORKSPACE_SLUG=$2; shift 2 ;;
    *) echo "FAIL: release-seed-drill-evidence.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ] || [ -z "$PHASE" ]; then
  echo "usage: release-seed-drill-evidence.sh <terraform root> <name prefix> --worker-digest D --phase before|in-flight|after [--workspace-slug S]" >&2
  exit 1
fi

# The refusal that makes this a rehearsal-only step. It is first, before the root, the
# digest or the phase is looked at, because a production prefix is not an argument list
# with a mistake in it — it is a command that must not be run at all.
rehearsal_require_prefix "$PREFIX"

case "$PHASE" in
  before | in-flight | after) ;;
  *)
    echo "FAIL: --phase takes before, in-flight or after, not '$PHASE'." >&2
    echo "      'before' writes the evidence the restore target must postdate; 'in-flight' leaves a send in" >&2
    echo "      doubt just before the target; 'after' adds the work the restore is meant to lose. There is" >&2
    echo "      no default: a phase reached by omission is a seed that silently did another one." >&2
    exit 1
    ;;
esac

case "$ROOT_DIRECTORY" in
  *roots/rehearsal) ;;
  *)
    echo "FAIL: '$ROOT_DIRECTORY' is not the rehearsal root, and this step runs nowhere else." >&2
    exit 1
    ;;
esac

if [ -z "$WORKER_DIGEST" ]; then
  echo "FAIL: --worker-digest is required. The wrapper refuses to launch a task whose image is not the digest this release is about, and it cannot compare against a digest it was not given." >&2
  exit 1
fi

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

rehearsal_log "seeding the $PHASE evidence of $PREFIX into workspace '$WORKSPACE_SLUG' from $ROOT_DIRECTORY"
rehearsal_log "fss admin drill seed-evidence --workspace-slug $WORKSPACE_SLUG --phase $PHASE --report /tmp/fss-drill-evidence.json"

# ---------------------------------------------------------------------------
# Everything the launch needs, from the root's own outputs — the same lines
# `release-bootstrap-workspace.sh` reads, because this runs on the same operations
# task definition under the same runtime credential, in the same VPC, against the
# same private database.
# ---------------------------------------------------------------------------
CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
OPERATIONS_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
RUNTIME_SECRET_ARN="$(release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn)"
NETWORK_PLAN="$(release_output "$ROOT_DIRECTORY" task_network_configuration json)"
LOG_GROUP="$(release_output "$ROOT_DIRECTORY" worker_log_group_name)"

DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"
ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
REGION="${AWS_REGION:-us-east-1}"

CAPTURE="$REPORTS/drill-evidence-$PHASE.log"
REPORT_JSON="$REPORTS/drill-evidence-$PHASE.json"

COMMAND=(admin drill seed-evidence
  --workspace-slug "$WORKSPACE_SLUG"
  --phase "$PHASE"
  --report /tmp/fss-drill-evidence.json)

# `FSS_DEPENDENCIES=recorded`, named out loud on this one launch.
#
# `infra/modules/cluster` fixes the mode in the *drill* task definition because the
# drill must never run any other way. The operations definition carries the
# environment's own mode, which the rehearsal root defaults to `live` so that sign-in
# rehearses the path production runs — and the tool refuses to seed in `live`, on
# purpose, because production's worker says `live` and production is never seeded. So
# the rehearsal names the recorded seam here, once, for the one command whose whole job
# is to make a reply and an opt-out arrive from a fake. It is a public identifier and
# the wrapper's own `--env` guard refuses anything that looks like a credential.
release_run_task \
  --step drill-evidence-"$PHASE" \
  --environment rehearsal \
  --prefix "$PREFIX" \
  --account "$ACCOUNT" \
  --region "$REGION" \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$OPERATIONS_TASK_DEFINITION" \
  --container operations \
  --network-plan "$NETWORK_PLAN" \
  --image-digest "$WORKER_DIGEST" \
  --database-host "$DATABASE_HOST" \
  --secret-arn "$RUNTIME_SECRET_ARN" \
  --log-group "$LOG_GROUP" \
  --log-stream-prefix operations \
  --env FSS_DEPENDENCIES=recorded \
  --capture "$CAPTURE" \
  -- "${COMMAND[@]}"

# ---------------------------------------------------------------------------
# The answer, out of the log stream, printed and recorded.
#
# `asOf` is the load-bearing field: it is the instant the tool measured its counts at,
# and `rehearsal-restore-drill.sh` waits for RDS to report a LatestRestorableTime later
# than it before reading the restore target.
# ---------------------------------------------------------------------------
if rehearsal_dry_run; then
  rehearsal_plan "read the task's log stream and take the JSON report out of it into $REPORT_JSON"
  rehearsal_plan "record asOf, which the restore drill waits for LatestRestorableTime to pass"
  rehearsal_write_report "drill-evidence-$PHASE.txt" \
    "planned prefix=$PREFIX phase=$PHASE workspace_slug=$WORKSPACE_SLUG asOf= worker_digest=$WORKER_DIGEST"
  rehearsal_log "dry run: nothing was launched and no evidence exists"
  exit 0
fi

release_captured_report "$CAPTURE" "$REPORT_JSON"
cat "$REPORT_JSON"

SUMMARY="$(FSS_REPORT="$REPORT_JSON" python3 -c '
import json, os

report = json.load(open(os.environ["FSS_REPORT"], encoding="utf-8"))
created = sum(1 for item in report.get("items") or [] if item.get("outcome") == "created")
print(
    "phase=%s workspace_id=%s asOf=%s created=%d sends=%s replies=%s suppressions=%s crm_edits=%s migrations=%s"
    % (
        report.get("phase", "unknown"),
        report.get("workspaceId", "unknown"),
        report.get("asOf", "unknown"),
        created,
        report.get("sends", 0),
        report.get("replies", 0),
        report.get("suppressions", 0),
        report.get("crm_edits", 0),
        report.get("migrations", 0),
    )
)
')"

rehearsal_write_report "drill-evidence-$PHASE.txt" \
  "prefix=$PREFIX workspace_slug=$WORKSPACE_SLUG $SUMMARY worker_digest=$WORKER_DIGEST"
rehearsal_log "the drill has evidence to reconstruct: $SUMMARY"
