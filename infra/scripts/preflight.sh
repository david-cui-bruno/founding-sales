#!/usr/bin/env bash
# A migration's preflight counts, read-only, before its schema release stops anything
# (P7, 27 September 2026; lane W2-M wrote the first of these, for 0019).
#
#   infra/scripts/preflight.sh <root> <prefix> <migration> --worker-digest D
#
#   infra/scripts/preflight.sh infra/roots/production fss-prod 0021 --worker-digest "$worker"   # the coordinator
#
# ## Why it runs before stop.sh
#
# A contract migration can refuse: 0021 raises FS021 and leaves the schema as it was when
# data it would drop is still stored. Finding that out at step 2 of `deploy.sh release
# --schema-change` means finding it out with both services stopped. This asks the same
# question while they are still running, and exits 3 when the migration would refuse, so
# the release chain stops before stop.sh does anything.
#
# ## How: the operations task, with this release's worker image
#
# `fss admin schema-preflight <migration>` counts inside a READ ONLY transaction it rolls
# back, on a one-off task of the operations definition, as the runtime identity, through
# lib.sh's release_run_task and its guards; the answer is read back out of the log stream.
# The command exists only for a migration the tool knows (`0020` and `0021` today); any
# other answers `command_unknown` from the tool, and this fails.
#
# The command is new in the release it belongs to, and before the apply the operations
# definition still runs the previous release's image. So when the registered image is not
# `--worker-digest`, this registers one revision of the operations family that differs from
# the registered one in the image digest and nothing else — same repository, roles, network
# mode, environment, secrets, log configuration and tags — launches the preflight on it, and
# deregisters it on the way out whatever happened, because the family's newest ACTIVE
# revision is the one the next plan reads. A deregistration ECS refuses fails the script.
# The services are not touched: nothing names that revision but this task.
#
# ## What it prints
#
# The tool's JSON answer in full, and one summary line in the reports directory as
# `schema-preflight-<migration>.txt`: the schema version, `refuses`, and each count under
# `counts.blocking`. `refuses=true` means the migration would refuse: do not release it;
# take the blocking counts to the owner, and amend the migration before it is applied
# anywhere. A migration whose report carries more than that is named in PREFLIGHT_EXTRAS
# below. 0020 (lane W3-F) has seventeen of its own: the settings rows by key, the unsent
# fences to recompose, the templates whose legacy footer block is deduped, the ids of
# anything that will be held for repair rather than sent — which is *not* a blocker — and
# the ids of any body that would not fit once the footer is composed, which is the only
# thing 0020 refuses on. 0021 (lane W3-C2) has six: the ids of the enrollments still in
# `review_required`, which are the only thing 0021 refuses on, the credential and
# generation rows it will destroy without asking, and the one check the database cannot
# make — which desktop build is installed, which the operator confirms by hand.
#
# Exit status: 0 when the migration would apply; 3 when it would refuse; 1 when anything
# failed — the launch, the answer, or the deregistration of the preflight's own revision,
# which wins over 3 because the next plan reads that revision. No dry run (P7);
# test/ops/preflight.check.ts drives it against a stub CLI.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
MIGRATION=${3:-}
shift 3 2>/dev/null || true

WORKER_DIGEST=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    *) echo "FAIL: preflight.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ] || [ -z "$MIGRATION" ] || [ -z "$WORKER_DIGEST" ]; then
  echo "usage: preflight.sh <terraform root> <name prefix> <migration> --worker-digest D" >&2
  exit 1
fi
if rehearsal_dry_run; then
  echo "FAIL: preflight.sh has no dry run (P7); test/ops/preflight.check.ts drives it against a stub CLI" >&2
  exit 1
fi
if [[ ! "$MIGRATION" =~ ^[0-9]{4}$ ]]; then
  echo "FAIL: '$MIGRATION' is not a migration number (four digits, as in packages/domain/db/migrations/0021_compat_cleanup.sql)" >&2
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
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-preflight-$MIGRATION.XXXXXX")"
NAME="schema-preflight-$MIGRATION"

rehearsal_log "migration $MIGRATION preflight for $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT), worker image $WORKER_DIGEST"
rehearsal_log "fss admin schema-preflight $MIGRATION --report /tmp/fss-preflight.json"

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
release_require_arn "the operations task definition" "$OPERATIONS_TASK_DEFINITION" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
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
release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$OPERATIONS_TASK_DEFINITION" --include TAGS --output json \
  >"$WORK/operations.json" || { echo "FAIL: ECS did not describe $OPERATIONS_TASK_DEFINITION" >&2; exit 1; }
# Writes next.json when a revision is needed, and prints `same` or `register`.
NEED="$(FSS_WORK="$WORK" FSS_DIGEST="$WORKER_DIGEST" FSS_PREFIX="$PREFIX" python3 - <<'PY'
# preflight-next
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

CAPTURE="$REPORTS/$NAME.log"
REPORT_JSON="$REPORTS/$NAME.json"

release_run_task \
  --step "$NAME" \
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
  -- admin schema-preflight "$MIGRATION" --report /tmp/fss-preflight.json || exit 1

release_captured_report "$CAPTURE" "$REPORT_JSON" || exit 1
cat "$REPORT_JSON"

SUMMARY="$(FSS_REPORT="$REPORT_JSON" FSS_MIGRATION="$MIGRATION" python3 - <<'PY'
# preflight-summary: the two fields and the blocking counts every migration reports, then
# whatever PREFLIGHT_EXTRAS names for this one.
import json, os
report = json.load(open(os.environ["FSS_REPORT"], encoding="utf-8"))
counts = report.get("counts") or {}
blocking = counts.get("blocking") or {}


def extras_0020():
    # Lane W3-F. 0020 destroys nothing — it widens one CHECK — so its report is about
    # what the *release* changes: the settings table the CHECK is replaced over, the
    # unsent fences whose footer the claim lock will recompose, the templates whose
    # legacy block composition will dedupe, and the bodies that would not fit once
    # composed (the only thing 0020 refuses on).
    settings = counts.get("settings") or []
    fences = counts.get("fences") or {}
    templates = counts.get("templates") or {}
    oversize = counts.get("oversize") or {}
    with_address = oversize.get("withMaxAddress") or {}
    repair = counts.get("repair") or {}

    def names(values):
        return ",".join(values) if values else "none"

    return [
        ("settings_rows_by_key",
         ",".join("%s:%s" % (row.get("settingKey", "?"), row.get("versions", "?")) for row in settings) or "none"),
        ("settings_current_rows", sum(int(row.get("current", 0)) for row in settings) if settings else 0),
        ("fences_prepared", fences.get("prepared", "unknown")),
        ("fences_held", fences.get("held", "unknown")),
        ("fences_to_recompose", fences.get("recomposed", "unknown")),
        ("fences_already_composed", fences.get("alreadyComposed", "unknown")),
        ("fences_without_template_version", fences.get("withoutTemplateVersion", "unknown")),
        ("fences_held_for_repair", fences.get("heldForRepair", "unknown")),
        ("templates_legacy_footer_deduped", templates.get("legacyFooterBlock", "unknown")),
        ("templates_footerless", templates.get("footerless", "unknown")),
        ("templates_ambiguous_footer", templates.get("ambiguousFooter", "unknown")),
        ("postal_address_configured", str((counts.get("postalAddress") or {}).get("configured", "unknown")).lower()),
        ("oversize_fences", names(oversize.get("fenceIds"))),
        ("oversize_templates", names(oversize.get("templateVersionIds"))),
        ("oversize_with_max_address",
         len(with_address.get("fenceIds") or []) + len(with_address.get("templateVersionIds") or [])),
        ("repair_fences", names(repair.get("fenceIds"))),
        ("repair_templates", names(repair.get("templateVersionIds"))),
    ]


def extras_0021():
    # Lane W3-C2. 0021 refuses on one thing — an enrollment still in `review_required` —
    # and destroys three sets of rows without asking, which are reported rather than
    # blocking. The installed-build check is not a count: it is the question the database
    # cannot answer, printed so that nobody assumes it was answered.
    review = counts.get("reviewRequired") or {}
    destroyed = counts.get("destroyed") or {}
    installed = counts.get("installedClientCheck") or {}
    seen = installed.get("clientVersionsSeen") or []

    def names(values):
        return ",".join(values) if values else "none"

    return [
        ("review_required_enrollments", names(review.get("enrollmentIds"))),
        ("active_refresh_credentials", destroyed.get("activeRefreshCredentials", "unknown")),
        ("refresh_credential_rows", destroyed.get("refreshCredentialRows", "unknown")),
        ("devices_past_first_generation", destroyed.get("devicesPastFirstGeneration", "unknown")),
        ("system_generation_rows", destroyed.get("systemGenerationRows", "unknown")),
        ("installed_client_check",
         "by_hand:" + (",".join("%s:%s" % (row.get("clientVersion") or "unknown", row.get("devices", "?"))
                                for row in seen) or "no_active_devices")),
    ]


PREFLIGHT_EXTRAS = {"0020": extras_0020, "0021": extras_0021}
fields = [("schema", report.get("schemaVersion", "unknown")), ("refuses", str(report.get("refuses", "unknown")).lower())]
fields += [("blocking_" + key, value) for key, value in sorted(blocking.items())]
fields += PREFLIGHT_EXTRAS.get(os.environ["FSS_MIGRATION"], list)()
print(" ".join("%s=%s" % (key, value) for key, value in fields))
PY
)"
rehearsal_write_report "$NAME.txt" "prefix=$PREFIX environment=$ENVIRONMENT worker_digest=$WORKER_DIGEST $SUMMARY"
case " $SUMMARY " in
  *" refuses=false "*)
    rehearsal_log "$MIGRATION needs no decision: nothing it refuses on is stored. $SUMMARY"
    ;;
  *" refuses=true "*)
    rehearsal_log "DECISION NEEDED: $MIGRATION would refuse. Do not release it: take the blocking counts above to the owner, and amend $MIGRATION before it is applied anywhere. $SUMMARY"
    echo "FAIL: $MIGRATION would refuse; the release stops here, before anything is stopped. $SUMMARY" >&2
    exit 3
    ;;
  *)
    echo "FAIL: the preflight's answer does not say whether $MIGRATION would refuse. $SUMMARY" >&2
    exit 1
    ;;
esac
