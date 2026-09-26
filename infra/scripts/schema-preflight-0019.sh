#!/usr/bin/env bash
# Migration 0019's counts, read-only, before the schema-19 release stops anything (lane W2-M).
#
#   infra/scripts/schema-preflight-0019.sh <root> <prefix> --worker-digest D
#
#   infra/scripts/schema-preflight-0019.sh infra/roots/production fss-prod --worker-digest "$worker"   # the coordinator
#
# ## Why it runs before release-stop.sh
#
# `packages/domain/db/migrations/0019_wave2_cleanup.sql` destroys research's eight
# tables (and the configuration rows seeded into three of them), archives
# `record_merge_events` into `audit_events` and drops it, drops `direct_sent`, the guard
# columns, the retired settings rows and the unreferenced reason codes, and relaxes the
# edit-in-place triggers and four CHECKs. It **refuses** — raises FS019 and leaves schema
# 18 as it was — when a LinkedIn marker or an audited enrollment migration it would drop
# is still stored, or when one of research's five data tables holds a row. Finding that
# out at step 2 of `release-deploy.sh` means finding it out with both services stopped.
# This prints the same counts while they are still running, and exits 3 when 0019 would
# refuse, so the release chain stops before release-stop.sh does anything.
#
# ## How: the operations task, with this release's worker image
#
# The same launch `release-deploy.sh --release-record` makes for the record put: a
# one-off task of the operations definition, as the runtime identity, through
# `release_run_task` and its guards, and the answer read back out of the log stream.
# The command is `fss admin schema-preflight 0019`, which counts inside a READ ONLY
# transaction it rolls back.
#
# That command is new in this release, and before the apply the operations definition
# still runs the previous release's image, which does not have it. So when the
# registered image is not `--worker-digest`, this registers one revision of the
# operations family that differs from the registered one in the image digest and
# nothing else — same repository, roles, network mode, environment, secrets, log
# configuration and tags — launches the preflight on it, and deregisters it on the way
# out whatever happened, because the family's newest ACTIVE revision is the one the next
# plan reads. A deregistration ECS refuses fails the script (exit 1). The services are
# not touched: nothing names that revision but this task.
#
# ## What it prints
#
# The tool's JSON answer (`counts`, `refuses`), and one summary line in the reports
# directory as `schema-preflight-0019.txt`. The summary keeps research's seeded
# configuration (`research_seed_rows`, dropped without asking) apart from its data
# (`research_data_rows`, which refuses). `refuses=true` means 0019 would raise FS019: do
# not release it; take the blocking counts to the owner, and amend 0019 before it is
# applied anywhere.
#
# Exit status: 0 when 0019 would apply; 3 when it would refuse; 1 when anything failed
# — the launch, the answer, or the deregistration of the preflight's own revision, which
# wins over 3 because the next plan reads that revision.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

WORKER_DIGEST=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    *) echo "FAIL: schema-preflight-0019.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ] || [ -z "$WORKER_DIGEST" ]; then
  echo "usage: schema-preflight-0019.sh <terraform root> <name prefix> --worker-digest D" >&2
  exit 1
fi
if [[ ! "$WORKER_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "FAIL: '$WORKER_DIGEST' is not an image digest (sha256:<64 hex>). The preflight runs this release's worker image, by digest." >&2
  exit 1
fi

ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")" || exit 1
case "$ENVIRONMENT:$ROOT_DIRECTORY" in
  production:*roots/production) ;;
  rehearsal:*roots/rehearsal) ;;
  *)
    echo "FAIL: prefix '$PREFIX' is a $ENVIRONMENT prefix and '$ROOT_DIRECTORY' is not the $ENVIRONMENT root." >&2
    exit 1
    ;;
esac

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-preflight-0019.XXXXXX")"

rehearsal_log "migration 0019 preflight for $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT), worker image $WORKER_DIGEST"
rehearsal_log "fss admin schema-preflight 0019 --report /tmp/fss-preflight-0019.json"

CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
OPERATIONS_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
RUNTIME_SECRET_ARN="$(release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn)"
NETWORK_PLAN="$(release_output "$ROOT_DIRECTORY" task_network_configuration json)"
LOG_GROUP="$(release_output "$ROOT_DIRECTORY" worker_log_group_name)"

DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"
ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
REGION="${AWS_REGION:-us-east-1}"

# The operations definition as Terraform registered it, held to this environment
# before anything is registered beside it.
if [ -n "$OPERATIONS_TASK_DEFINITION" ] || ! rehearsal_dry_run; then
  release_require_arn "the operations task definition" "$OPERATIONS_TASK_DEFINITION" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
fi
release_refuse_foreign_arguments "$ENVIRONMENT" "$CLUSTER_ARN" "$OPERATIONS_TASK_DEFINITION" || exit 1

TEMPORARY_REVISION=''
# On exit, whatever happened. A deregistration ECS refuses leaves the revision as the
# family's newest ACTIVE one, which the next plan reads, so the script fails then even
# after a successful count (review of PRs 246 and 247, 26 September 2026).
deregister_temporary() {
  local status=$?
  if [ -n "$TEMPORARY_REVISION" ]; then
    if release_aws "$ENVIRONMENT" ecs deregister-task-definition --task-definition "$TEMPORARY_REVISION" --output json >/dev/null; then
      rehearsal_log "deregistered $TEMPORARY_REVISION, the preflight's own revision"
    else
      echo "FAIL: could not deregister $TEMPORARY_REVISION. It is the newest ACTIVE revision of the operations family, which the next plan reads; deregister it with the admin profile before the apply: aws ecs deregister-task-definition --task-definition $TEMPORARY_REVISION" >&2
      status=1
    fi
    TEMPORARY_REVISION=''
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap deregister_temporary EXIT

LAUNCH_DEFINITION=$OPERATIONS_TASK_DEFINITION
if rehearsal_dry_run; then
  rehearsal_plan "aws ecs describe-task-definition --task-definition ${OPERATIONS_TASK_DEFINITION:-<operations task definition>} --include TAGS"
  rehearsal_plan "unless its image is already @$WORKER_DIGEST: aws ecs register-task-definition with that document and the image's digest replaced by $WORKER_DIGEST, and nothing else"
  rehearsal_plan "on exit, whatever happened: aws ecs deregister-task-definition --task-definition <that revision>"
else
  release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$OPERATIONS_TASK_DEFINITION" --include TAGS --output json \
    >"$WORK/operations.json" || { echo "FAIL: ECS did not describe $OPERATIONS_TASK_DEFINITION" >&2; exit 1; }
  # Writes next.json when a revision is needed, and prints `same` or `register`.
  NEED="$(FSS_WORK="$WORK" FSS_DIGEST="$WORKER_DIGEST" FSS_PREFIX="$PREFIX" python3 - <<'PY'
# schema-preflight-0019-next
import json, os, re, sys
env = os.environ
document = json.load(open(os.path.join(env["FSS_WORK"], "operations.json"), encoding="utf-8"))
definition = dict(document.get("taskDefinition") or {})
tags = document.get("tags") or []
containers = definition.get("containerDefinitions") or []
if len(containers) != 1 or containers[0].get("name") != "operations":
    print("FAIL: the operations definition must have exactly one container, named operations", file=sys.stderr)
    sys.exit(1)
image = str(containers[0].get("image", ""))
match = re.fullmatch(r"([0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/" + re.escape(env["FSS_PREFIX"]) + r"-worker)@(sha256:[0-9a-f]{64})", image)
if not match:
    print("FAIL: the operations definition runs '{}', which is not this environment's worker repository by digest".format(image), file=sys.stderr)
    sys.exit(1)
if match.group(2) == env["FSS_DIGEST"]:
    print("same")
    sys.exit(0)
if not any(tag.get("key") == "NamePrefix" and tag.get("value") == env["FSS_PREFIX"] for tag in tags):
    print("FAIL: the operations definition does not carry NamePrefix={}; a revision registered without it is refused by the role".format(env["FSS_PREFIX"]), file=sys.stderr)
    sys.exit(1)
for field in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
              "registeredAt", "registeredBy", "deregisteredAt"):
    definition.pop(field, None)
container = dict(containers[0])
container["image"] = match.group(1) + "@" + env["FSS_DIGEST"]
definition["containerDefinitions"] = [container]
if tags:
    definition["tags"] = tags
json.dump(definition, open(os.path.join(env["FSS_WORK"], "next.json"), "w", encoding="utf-8"))
print("register")
PY
)" || exit 1
  if [ "$NEED" = "register" ]; then
    release_aws "$ENVIRONMENT" ecs register-task-definition --cli-input-json "file://$WORK/next.json" --output json \
      >"$WORK/registered.json" || { echo "FAIL: ECS did not register the preflight's revision of the operations family" >&2; exit 1; }
    TEMPORARY_REVISION="$(release_json_path "$(cat "$WORK/registered.json")" "taskDefinition.taskDefinitionArn")"
    if [ -z "$TEMPORARY_REVISION" ]; then
      echo "FAIL: ECS registered a revision and did not say which" >&2
      exit 1
    fi
    LAUNCH_DEFINITION=$TEMPORARY_REVISION
    rehearsal_log "registered $TEMPORARY_REVISION: the operations definition with the image @$WORKER_DIGEST and nothing else changed"
  else
    rehearsal_log "$OPERATIONS_TASK_DEFINITION already runs @$WORKER_DIGEST; launching it as registered"
  fi
fi

CAPTURE="$REPORTS/schema-preflight-0019.log"
REPORT_JSON="$REPORTS/schema-preflight-0019.json"

release_run_task \
  --step schema-preflight-0019 \
  --environment "$ENVIRONMENT" \
  --prefix "$PREFIX" \
  --account "$ACCOUNT" \
  --region "$REGION" \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$LAUNCH_DEFINITION" \
  --container operations \
  --network-plan "$NETWORK_PLAN" \
  --image-digest "$WORKER_DIGEST" \
  --database-host "$DATABASE_HOST" \
  --secret-arn "$RUNTIME_SECRET_ARN" \
  --log-group "$LOG_GROUP" \
  --log-stream-prefix operations \
  --capture "$CAPTURE" \
  -- admin schema-preflight 0019 --report /tmp/fss-preflight-0019.json || exit 1

if rehearsal_dry_run; then
  rehearsal_plan "read the task's log stream and take the JSON answer out of it into $REPORT_JSON"
  rehearsal_write_report "schema-preflight-0019.txt" "planned prefix=$PREFIX environment=$ENVIRONMENT worker_digest=$WORKER_DIGEST"
  rehearsal_log "dry run: nothing was registered, launched or counted"
  exit 0
fi

release_captured_report "$CAPTURE" "$REPORT_JSON" || exit 1
cat "$REPORT_JSON"

SUMMARY="$(FSS_REPORT="$REPORT_JSON" python3 -c '
import json, os
report = json.load(open(os.environ["FSS_REPORT"], encoding="utf-8"))
counts = report.get("counts") or {}
blocking = counts.get("blocking") or {}
destroyed = counts.get("destroyed") or {}
seed = destroyed.get("researchSeed") or {}
research_data = ("researchProviderLedger", "researchPages", "firmLocations", "researchFirmRuns", "researchSuggestions")
references = counts.get("reasonCodeReferences") or {}
relaxed = counts.get("relaxed") or {}
fields = [
    ("schema", report.get("schemaVersion", "unknown")),
    ("refuses", str(report.get("refuses", "unknown")).lower()),
]
fields += [("blocking_" + key, value) for key, value in sorted(blocking.items())]
fields += [
    ("research_seed_rows", sum(seed.values()) if seed else "unknown"),
    ("research_data_rows", sum(blocking.get(key, 0) for key in research_data) if blocking else "unknown"),
    ("record_merge_events_archived", counts.get("archivedMergeEvents", "unknown")),
    ("direct_sent_days", destroyed.get("directSentDays", "unknown")),
    ("guard_columns_changed", destroyed.get("guardColumnsChanged", "unknown")),
    ("retired_setting_rows", destroyed.get("alertThresholdsRows", 0) + destroyed.get("clientVersionRangeRows", 0)),
    ("domain_cap_references", references.get("domainCap", "unknown")),
    ("dead_job_references", references.get("deadJob", "unknown")),
    ("snoozes_with_placeholder_reason", relaxed.get("snoozesWithPlaceholderReason", "unknown")),
    ("review_required_enrollments", counts.get("reviewRequiredEnrollments", "unknown")),
]
print(" ".join("%s=%s" % (key, value) for key, value in fields))
')"
rehearsal_write_report "schema-preflight-0019.txt" "prefix=$PREFIX environment=$ENVIRONMENT worker_digest=$WORKER_DIGEST $SUMMARY"
case " $SUMMARY " in
  *" refuses=false "*)
    rehearsal_log "0019 needs no decision: nothing it refuses on is stored. $SUMMARY"
    ;;
  *" refuses=true "*)
    rehearsal_log "DECISION NEEDED: 0019 would refuse (FS019). Do not release it: take the blocking counts above to the owner, and amend 0019 before it is applied anywhere. $SUMMARY"
    echo "FAIL: 0019 would refuse (FS019); the release stops here, before anything is stopped. $SUMMARY" >&2
    exit 3
    ;;
  *)
    echo "FAIL: the preflight's answer does not say whether 0019 would refuse. $SUMMARY" >&2
    exit 1
    ;;
esac
