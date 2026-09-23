#!/usr/bin/env bash
# The first workspace and its first admin, in either environment (lane g39).
#
#   infra/scripts/release-bootstrap-workspace.sh <root> <prefix> \
#       --worker-digest D --slug S --display-name N --admin-email E [--time-zone Z] \
#       [--environment production]
#
#   infra/scripts/release-bootstrap-workspace.sh infra/roots/rehearsal fss-rh-0923 \
#       --worker-digest "$digest" --slug rehearsal --display-name Rehearsal \
#       --admin-email rehearsal-admin@usecallie.com                          # CI
#
#   infra/scripts/release-bootstrap-workspace.sh infra/roots/production fss-prod \
#       --environment production --worker-digest "$digest" \
#       --slug callie --display-name Callie --admin-email callie@usecallie.com  # David
#
# ## Why a deployed environment needs this step at all
#
# A migrated database has no `workspaces` row, and three things then do not work and
# cannot be made to work from outside:
#
#   * **nobody can sign in.** `apps/api/src/auth/signIn.ts` refuses with
#     `workspace_unknown` unless the workspace exists and with `membership_required`
#     unless an *active* membership exists — while the `users` row is only written at
#     the end of a successful sign-in. Three rows that each presuppose the others;
#   * **the scheduler has nothing to do.** `apps/worker/src/scheduler/sources.ts`
#     inserts one canary per workspace (`SELECT id FROM workspaces`), so an empty
#     database produces no canary, no `CanaryCompletionAgeSeconds` datapoint and,
#     because the `canary_stale` alarm is `treat_missing_data = breaching`, an alarm
#     that stays in ALARM for a correct deployment;
#   * **the production smoke has nothing to judge**, which is how run 35919040315 of
#     23 September 2026 failed: ten one-minute attempts and no datapoint.
#
# ## One code path, two environments, and one extra word for production
#
# Like `infra/scripts/release-deploy.sh`, this runs the same code for the rehearsal and
# for production: the difference is the credentials in the shell and the root in
# argument one, and `release-common.sh` refuses a rehearsal command that names
# production and a production command that names a rehearsal run.
#
# It asks for one thing that script does not: `--environment production`. Every other
# release step is idempotent in the sense that it converges on what the plan already
# says; this one writes the first *business* rows of an environment — a slug and an
# admin address that the desktop's sign-in form and the audit trail will then carry.
# Naming production out loud is cheap, and a rehearsal argument list run against the
# production root with a stale shell is the mistake it prevents.
#
# ## What it prints, and where the answer comes from
#
# A one-off Fargate task's filesystem goes away with the task, so `--report` inside the
# container cannot be read afterwards. What survives is the log stream: the tool prints
# one JSON object on stdout and every log line on stderr, and `release_captured_report`
# takes the object back out of the capture. That JSON is printed here and summarised
# into the reports directory as `bootstrap-workspace.txt`, because the workspace UUID it
# names is what a person types into the desktop's Workspace field.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

WORKER_DIGEST=''
SLUG=''
DISPLAY_NAME=''
ADMIN_EMAIL=''
TIME_ZONE=''
NAMED_ENVIRONMENT=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    --slug) SLUG=$2; shift 2 ;;
    --display-name) DISPLAY_NAME=$2; shift 2 ;;
    --admin-email) ADMIN_EMAIL=$2; shift 2 ;;
    --time-zone) TIME_ZONE=$2; shift 2 ;;
    --environment) NAMED_ENVIRONMENT=$2; shift 2 ;;
    *) echo "FAIL: release-bootstrap-workspace.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ] || [ -z "$SLUG" ] || [ -z "$DISPLAY_NAME" ] || [ -z "$ADMIN_EMAIL" ]; then
  echo "usage: release-bootstrap-workspace.sh <terraform root> <name prefix> --worker-digest D --slug S --display-name N --admin-email E [--time-zone Z] [--environment production]" >&2
  exit 1
fi

ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")"

# The root and the prefix must be the same environment, exactly as release-deploy.sh
# requires: a production root under a rehearsal prefix would read a rehearsal plan.
case "$ENVIRONMENT:$ROOT_DIRECTORY" in
  production:*roots/production) ;;
  rehearsal:*roots/rehearsal) ;;
  *)
    echo "FAIL: prefix '$PREFIX' is a $ENVIRONMENT prefix and '$ROOT_DIRECTORY' is not the $ENVIRONMENT root." >&2
    exit 1
    ;;
esac

# The extra word. A production run says so; a rehearsal run may say `--environment
# rehearsal` but need not, and neither may name the other one.
if [ -n "$NAMED_ENVIRONMENT" ] && [ "$NAMED_ENVIRONMENT" != "$ENVIRONMENT" ]; then
  echo "FAIL: --environment $NAMED_ENVIRONMENT was given and '$PREFIX' is a $ENVIRONMENT prefix." >&2
  exit 1
fi
if [ "$ENVIRONMENT" = production ] && [ "$NAMED_ENVIRONMENT" != production ]; then
  echo "FAIL: '$PREFIX' is the production namespace and this command writes the first workspace, the first user and the first membership of it." >&2
  echo "      Those rows carry a slug, an admin address and a workspace UUID a person will type into the desktop," >&2
  echo "      so production is named out loud or not at all: re-run with --environment production." >&2
  exit 1
fi

if [ -z "$WORKER_DIGEST" ]; then
  echo "FAIL: --worker-digest is required. The wrapper refuses to launch a task whose image is not the digest this release is about, and it cannot compare against a digest it was not given." >&2
  exit 1
fi

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

# The zone the command will use. Empty here means the command's own default, which is
# `America/New_York` — the same value migration 0001 gives the column — and the flag is
# then not passed at all rather than passed as an empty string.
EFFECTIVE_TIME_ZONE=${TIME_ZONE:-America/New_York}

rehearsal_log "bootstrapping the first workspace of $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT)"
rehearsal_log "fss admin workspace bootstrap --slug $SLUG --display-name $DISPLAY_NAME --admin-email $ADMIN_EMAIL --time-zone $EFFECTIVE_TIME_ZONE --report /tmp/fss-bootstrap.json"

# ---------------------------------------------------------------------------
# Everything the launch needs, from the root's own outputs — the same lines
# `release-deploy.sh` reads for its `verify` step, because this runs on the same
# operations task definition under the same runtime credential.
# ---------------------------------------------------------------------------
CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
OPERATIONS_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
RUNTIME_SECRET_ARN="$(release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn)"
NETWORK_PLAN="$(release_output "$ROOT_DIRECTORY" task_network_configuration json)"
LOG_GROUP="$(release_output "$ROOT_DIRECTORY" worker_log_group_name)"

DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"
ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
REGION="${AWS_REGION:-us-east-1}"

CAPTURE="$REPORTS/bootstrap-workspace.log"
REPORT_JSON="$REPORTS/bootstrap-workspace.json"

# The command, as words, so the wrapper's namespace refusal reads it like any other
# argument and so the optional flag is genuinely optional.
COMMAND=(admin workspace bootstrap
  --slug "$SLUG"
  --display-name "$DISPLAY_NAME"
  --admin-email "$ADMIN_EMAIL"
  --report /tmp/fss-bootstrap.json)
if [ -n "$TIME_ZONE" ]; then
  COMMAND+=(--time-zone "$TIME_ZONE")
fi

release_run_task \
  --step bootstrap-workspace \
  --environment "$ENVIRONMENT" \
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
  --capture "$CAPTURE" \
  -- "${COMMAND[@]}"

# ---------------------------------------------------------------------------
# The answer, out of the log stream, printed and recorded.
# ---------------------------------------------------------------------------
if rehearsal_dry_run; then
  rehearsal_plan "read the task's log stream and take the JSON report out of it into $REPORT_JSON"
  rehearsal_plan "print the report, whose workspace.id is what the desktop's Workspace field takes"
  rehearsal_write_report "bootstrap-workspace.txt" \
    "planned prefix=$PREFIX environment=$ENVIRONMENT slug=$SLUG time_zone=$EFFECTIVE_TIME_ZONE worker_digest=$WORKER_DIGEST"
  rehearsal_log "dry run: nothing was launched and no workspace exists"
  exit 0
fi

release_captured_report "$CAPTURE" "$REPORT_JSON"
cat "$REPORT_JSON"

SUMMARY="$(FSS_REPORT="$REPORT_JSON" python3 -c '
import json, os

report = json.load(open(os.environ["FSS_REPORT"], encoding="utf-8"))
workspace = report.get("workspace") or {}
admin = report.get("admin") or {}
membership = report.get("membership") or {}
print(
    "workspace_id=%s slug=%s workspace=%s admin=%s membership=%s role=%s"
    % (
        workspace.get("id", "unknown"),
        workspace.get("slug", "unknown"),
        workspace.get("outcome", "unknown"),
        admin.get("outcome", "unknown"),
        membership.get("outcome", "unknown"),
        membership.get("role", "unknown"),
    )
)
')"

rehearsal_write_report "bootstrap-workspace.txt" \
  "prefix=$PREFIX environment=$ENVIRONMENT $SUMMARY worker_digest=$WORKER_DIGEST"
rehearsal_log "the first workspace exists: $SUMMARY"
