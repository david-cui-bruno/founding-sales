#!/usr/bin/env bash
# The one library every release script sources (P7, 26 September 2026; it replaces
# release-common.sh and rehearsal-common.sh, which now only source this file).
#
# Sourced, never executed. It holds:
#   * the two namespaces and the symmetric refusal: a rehearsal command may not name
#     `fss-prod`, a production command may not name `fss-rh-`;
#   * dry-run mode (FSS_REHEARSAL_DRY_RUN=1: print every call, make none), the log line
#     and the report writer;
#   * the AWS and Terraform wrappers and `terraform output` reads;
#   * the one-off ECS task runner: every guard before the launch, a fingerprinted record
#     so a retry waits instead of launching twice, up to three launches for an image the
#     registry does not serve yet, and the task's log stream kept beside the record;
#   * the release-record put, shared by record.sh and the CI deploy.
#
# Offline seams: FSS_REHEARSAL_AWS_COMMAND (the AWS CLI), TERRAFORM, and one
# FSS_RELEASE_* fixture per AWS answer the runner reads. Nothing here prints a secret.

# shellcheck disable=SC2034 # the variables set here are read by the scripts that source it
set -euo pipefail

PRODUCTION_PREFIX='fss-prod'
REHEARSAL_PREFIX_PATTERN='^fss-rh-[a-z0-9-]{3,18}$'
# The old names.
RELEASE_PRODUCTION_PREFIX=$PRODUCTION_PREFIX
RELEASE_REHEARSAL_PREFIX_PATTERN=$REHEARSAL_PREFIX_PATTERN

# One-off task budget, log-stream grace and poll, and the image-pull retry (lane g80).
RELEASE_DEFAULT_TIMEOUT_SECONDS=1200
RELEASE_LOG_GRACE_SECONDS=${RELEASE_LOG_GRACE_SECONDS:-60}
RELEASE_LOG_POLL_SECONDS=${RELEASE_LOG_POLL_SECONDS:-5}
RELEASE_PULL_ATTEMPTS=${RELEASE_PULL_ATTEMPTS:-3}
RELEASE_PULL_BACKOFF_SECONDS=${RELEASE_PULL_BACKOFF_SECONDS:-30}

# ---------------------------------------------------------------------------
# Logging, dry run, reports
# ---------------------------------------------------------------------------

rehearsal_dry_run() {
  [ "${FSS_REHEARSAL_DRY_RUN:-0}" = "1" ]
}

rehearsal_log() {
  printf '%s %s\n' "[$(basename "${BASH_SOURCE[1]:-release}")]" "$*"
}

rehearsal_plan() {
  printf 'PLAN %s\n' "$*"
}

# A plan line from a helper whose stdout is the answer goes to stderr.
release_plan_note() {
  printf 'PLAN %s\n' "$*" >&2
}

rehearsal_report_dir() {
  echo "${FSS_REHEARSAL_REPORTS:-/tmp/fss-rehearsal}"
}

rehearsal_write_report() {
  local name=$1 directory
  shift
  directory="$(rehearsal_report_dir)"
  mkdir -p "$directory"
  printf '%s\n' "$*" > "$directory/$name"
  rehearsal_log "wrote $directory/$name"
}

# ---------------------------------------------------------------------------
# Namespaces
# ---------------------------------------------------------------------------

rehearsal_require_prefix() {
  local prefix=${1:-}
  if [ -z "$prefix" ]; then
    echo "FAIL: a rehearsal script needs a name prefix (fss-rh-<run>)" >&2
    return 1
  fi
  if [[ ! "$prefix" =~ $REHEARSAL_PREFIX_PATTERN ]]; then
    echo "FAIL: '$prefix' is not a rehearsal prefix; it must match $REHEARSAL_PREFIX_PATTERN" >&2
    return 1
  fi
  case "$prefix" in
    "$PRODUCTION_PREFIX"*) echo "FAIL: '$prefix' begins with the production prefix" >&2; return 1 ;;
  esac
}

# release_environment_for_prefix fss-prod -> production; fss-rh-0921 -> rehearsal
release_environment_for_prefix() {
  local prefix=${1:-}
  if [ "$prefix" = "$PRODUCTION_PREFIX" ]; then echo production; return 0; fi
  if [[ "$prefix" =~ $REHEARSAL_PREFIX_PATTERN ]]; then echo rehearsal; return 0; fi
  echo "FAIL: '${prefix:-<empty>}' is neither the production prefix (${PRODUCTION_PREFIX}) nor a rehearsal prefix (${REHEARSAL_PREFIX_PATTERN})" >&2
  return 1
}

rehearsal_refuse_production_arguments() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      *"$PRODUCTION_PREFIX"*) echo "FAIL: a rehearsal command names a production resource: $argument" >&2; return 1 ;;
    esac
  done
}

# The symmetric refusal. `|| return 1` at every call site: the refusal must be the
# answer even where the caller has errexit suppressed.
release_refuse_foreign_arguments() {
  local environment=$1 argument
  shift
  case "$environment" in
    rehearsal) rehearsal_refuse_production_arguments "$@" || return 1 ;;
    production)
      for argument in "$@"; do
        case "$argument" in
          *fss-rh-*) echo "FAIL: a production command names a rehearsal resource: $argument" >&2; return 1 ;;
        esac
      done
      ;;
    *) echo "FAIL: '$environment' is not an environment this script knows" >&2; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# The AWS CLI and Terraform
# ---------------------------------------------------------------------------

rehearsal_aws_command() {
  echo "${FSS_REHEARSAL_AWS_COMMAND:-aws}"
}

# Every AWS call a release command makes.   release_aws <environment> <aws arguments...>
release_aws() {
  local environment=$1
  shift
  release_refuse_foreign_arguments "$environment" "$@" || return 1
  if rehearsal_dry_run; then
    rehearsal_plan "aws $*"
    return 0
  fi
  command "$(rehearsal_aws_command)" "$@"
}

rehearsal_aws() {
  release_aws rehearsal "$@"
}

rehearsal_terraform() {
  rehearsal_refuse_production_arguments "$@" || return 1
  if rehearsal_dry_run; then
    rehearsal_plan "terraform $*"
    return 0
  fi
  command "${TERRAFORM:-terraform}" "$@"
}

# `terraform output` from a root; FSS_RELEASE_OUTPUT_<NAME> answers offline.
#   release_output <root> <name> [raw|json]
release_output() {
  local root=$1 name=$2 form=${3:-raw} fixture_variable
  fixture_variable="FSS_RELEASE_OUTPUT_$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')"
  if [ "${!fixture_variable+set}" = "set" ]; then
    printf '%s\n' "${!fixture_variable}"
    return 0
  fi
  if rehearsal_dry_run; then
    release_plan_note "terraform -chdir=$root output -$form $name"
    return 0
  fi
  command "${TERRAFORM:-terraform}" -chdir="$root" output "-$form" "$name"
}

# release_json_path <json> <dotted.path> [default]
release_json_path() {
  FSS_JSON="$1" FSS_PATH="$2" FSS_DEFAULT="${3-}" python3 -c '
import json, os, sys
value = json.loads(os.environ["FSS_JSON"] or "null")
for part in os.environ["FSS_PATH"].split("."):
    if value is None:
        break
    if part.isdigit() and isinstance(value, list):
        value = value[int(part)] if int(part) < len(value) else None
    elif isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
if value is None:
    sys.stdout.write(os.environ["FSS_DEFAULT"])
elif isinstance(value, bool):
    sys.stdout.write("true" if value else "false")
elif isinstance(value, (str, int, float)):
    sys.stdout.write(str(value))
else:
    json.dump(value, sys.stdout)
'
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

# A full ARN in this account, region and namespace; a bare name resolves against
# whatever the shell holds.
#   release_require_arn <what> <arn> <service> <account> <region> <prefix>
release_require_arn() {
  local what=$1 arn=$2 service=$3 account=$4 region=$5 prefix=$6
  if [[ ! "$arn" =~ ^arn:aws[a-z0-9-]*:${service}:([a-z0-9-]+):([0-9]{12}):(.+)$ ]]; then
    echo "FAIL: $what must be a full ${service} ARN, not '${arn:-<empty>}'. A bare name resolves against whichever account and region the shell happens to hold." >&2
    return 1
  fi
  local arn_region=${BASH_REMATCH[1]} arn_account=${BASH_REMATCH[2]} arn_tail=${BASH_REMATCH[3]}
  if [ "$arn_region" != "$region" ]; then
    echo "FAIL: $what is in $arn_region and this release is in $region" >&2
    return 1
  fi
  if [ "$arn_account" != "$account" ]; then
    echo "FAIL: $what is in account $arn_account and this release is in $account" >&2
    return 1
  fi
  case "$arn_tail" in
    *"$prefix"*) ;;
    *) echo "FAIL: $what does not carry this environment's namespace ($prefix): $arn" >&2; return 1 ;;
  esac
}

release_caller_account() {
  if [ "${FSS_RELEASE_CALLER_ACCOUNT+set}" = "set" ]; then
    printf '%s' "${FSS_RELEASE_CALLER_ACCOUNT}"
    return 0
  fi
  if rehearsal_dry_run; then
    release_plan_note "aws sts get-caller-identity --query Account --output text"
    return 0
  fi
  command "$(rehearsal_aws_command)" sts get-caller-identity --query Account --output text
}

# The cluster's own Environment tag (infra/modules/stack sets it).
release_cluster_environment_tag() {
  local environment=$1 cluster_arn=$2 tags
  if [ "${FSS_RELEASE_CLUSTER_TAGS+set}" = "set" ]; then
    tags=${FSS_RELEASE_CLUSTER_TAGS}
  elif rehearsal_dry_run; then
    release_plan_note "aws ecs describe-clusters --clusters $cluster_arn --include TAGS --query clusters[0].tags"
    return 0
  else
    tags="$(release_aws "$environment" ecs describe-clusters --clusters "$cluster_arn" --include TAGS \
      --query 'clusters[0].tags' --output json)"
  fi
  FSS_JSON="$tags" python3 -c '
import json, os, sys
for tag in json.loads(os.environ["FSS_JSON"] or "[]") or []:
    if tag.get("key") == "Environment":
        sys.stdout.write(str(tag.get("value", "")))
        break
'
}

# `desired running pending` of an ACTIVE service; anything else is a refusal. In dry-run
# mode without the FSS_RELEASE_SERVICES fixture it prints nothing ("not judged").
#   release_service_counts <environment> <cluster arn> <service name>
release_service_counts() {
  local environment=$1 cluster=$2 service=$3 described
  if [ "${FSS_RELEASE_SERVICES+set}" = "set" ]; then
    described=${FSS_RELEASE_SERVICES}
  elif rehearsal_dry_run; then
    release_plan_note "aws ecs describe-services --cluster $cluster --services $service"
    return 0
  else
    described="$(release_aws "$environment" ecs describe-services --cluster "$cluster" --services "$service" \
      --output json)" || return 1
  fi
  FSS_JSON="$described" FSS_NAME="$service" python3 -c '
import json, os, sys
name = os.environ["FSS_NAME"]
answer = json.loads(os.environ["FSS_JSON"] or "{}") or {}
for entry in answer.get("services") or []:
    if entry.get("serviceName") == name or str(entry.get("serviceArn", "")).endswith("/" + name):
        status = entry.get("status")
        if status != "ACTIVE":
            print("FAIL: ECS reports {} as {}, not ACTIVE".format(name, status or "no status"), file=sys.stderr)
            sys.exit(1)
        counts = [entry.get(field) for field in ("desiredCount", "runningCount", "pendingCount")]
        if any(not isinstance(count, int) for count in counts):
            print("FAIL: ECS did not report all three counts for {}".format(name), file=sys.stderr)
            sys.exit(1)
        print(" ".join(str(count) for count in counts))
        sys.exit(0)
reasons = ", ".join("{} {}".format(failure.get("reason", "?"), failure.get("arn", "")).strip() for failure in answer.get("failures") or [])
print("FAIL: ECS does not describe a service named {}{}".format(name, " ({})".format(reasons) if reasons else ""), file=sys.stderr)
sys.exit(1)
'
}

#   release_require_service_stopped <environment> <cluster arn> <service name>
release_require_service_stopped() {
  local environment=$1 cluster=$2 service=$3 counts desired running pending
  counts="$(release_service_counts "$environment" "$cluster" "$service")" || return 1
  if [ -z "$counts" ]; then
    if rehearsal_dry_run; then
      rehearsal_plan "refuse unless $service is at desired 0, running 0, pending 0"
      return 0
    fi
    echo "FAIL: nothing reported the counts of $service" >&2
    return 1
  fi
  read -r desired running pending <<<"$counts"
  if [ "$desired" != "0" ] || [ "$running" != "0" ] || [ "$pending" != "0" ]; then
    echo "FAIL: $service is not stopped: desired $desired, running $running, pending $pending." >&2
    return 1
  fi
  rehearsal_log "$service is stopped: desired 0, running 0, pending 0"
}

# A stable service may be a rolled-back one, so after every deploy the running tasks are
# read: one deployment that did not fail, exactly the declared count RUNNING, every task
# on that deployment's definition, and the container's pulled digest the release's.
#   release_require_running_digest <environment> <cluster> <service> <container> <digest> <declared count>
release_require_running_digest() {
  local environment=$1 cluster=$2 service=$3 container=$4 digest=$5 expected=$6
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecs describe-services --cluster $cluster --services $service --output json"
    rehearsal_plan "aws ecs list-tasks --cluster $cluster --service-name $service --desired-status RUNNING --output json"
    rehearsal_plan "aws ecs describe-tasks --cluster $cluster --tasks <every running task of $service> --output json"
    rehearsal_plan "refuse unless $service runs $expected task(s) of its one deployment and every $container container runs ${digest:-<the digest a real run requires>}"
    return 0
  fi
  if [ -z "$digest" ]; then
    echo "FAIL: nothing names the digest $service should be running, so what it runs cannot be checked" >&2
    return 1
  fi
  local services listed described arns
  services="$(release_aws "$environment" ecs describe-services --cluster "$cluster" --services "$service" --output json)" || return 1
  listed="$(release_aws "$environment" ecs list-tasks --cluster "$cluster" --service-name "$service" \
    --desired-status RUNNING --output json)" || return 1
  arns="$(FSS_JSON="$listed" python3 -c '
import json, os, sys
sys.stdout.write(" ".join((json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("taskArns") or []))
')"
  described='{"tasks": []}'
  if [ -n "$arns" ]; then
    # shellcheck disable=SC2086 # one word per task ARN
    described="$(release_aws "$environment" ecs describe-tasks --cluster "$cluster" --tasks $arns --output json)" || return 1
  fi
  FSS_SERVICES="$services" FSS_TASKS="$described" FSS_NAME="$service" FSS_CONTAINER="$container" \
    FSS_DIGEST="$digest" FSS_EXPECTED="$expected" python3 -c '
import json, os, sys
name, container, digest = os.environ["FSS_NAME"], os.environ["FSS_CONTAINER"], os.environ["FSS_DIGEST"]
expected = int(os.environ["FSS_EXPECTED"])
failures = []
def short(arn):
    return str(arn or "<none>").rsplit("/", 1)[-1]
entry = next((c for c in (json.loads(os.environ["FSS_SERVICES"] or "{}") or {}).get("services") or []
              if c.get("serviceName") == name or str(c.get("serviceArn", "")).endswith("/" + name)), None)
if entry is None:
    print("FAIL: ECS does not describe a service named {}".format(name), file=sys.stderr)
    sys.exit(1)
if entry.get("status") != "ACTIVE":
    failures.append("ECS reports it as {}, not ACTIVE".format(entry.get("status") or "no status"))
deployments = entry.get("deployments") or []
primary = next((d for d in deployments if d.get("status") == "PRIMARY"), None)
if primary is None:
    failures.append("it has no PRIMARY deployment")
    primary = {}
if len(deployments) != 1:
    failures.append("it has {} deployments, so a rollout is still under way or rolling back".format(len(deployments)))
if primary.get("rolloutState") == "FAILED":
    failures.append("its deployment failed: {}".format(primary.get("rolloutStateReason") or "no reason given"))
definition = primary.get("taskDefinition")
tasks = [t for t in (json.loads(os.environ["FSS_TASKS"] or "{}") or {}).get("tasks") or [] if t.get("lastStatus") == "RUNNING"]
if len(tasks) != expected:
    failures.append("{} task(s) are RUNNING and the root declares {}".format(len(tasks), expected))
for task in tasks:
    label = "task {}".format(short(task.get("taskArn")))
    if definition and task.get("taskDefinitionArn") != definition:
        failures.append("{} runs {}, and the deployment is {}".format(label, short(task.get("taskDefinitionArn")), short(definition)))
    found = next((c for c in task.get("containers") or [] if c.get("name") == container), None)
    if found is None:
        failures.append("{} has no container named {}".format(label, container))
        continue
    running = found.get("imageDigest")
    if not running:
        failures.append("{}: container {} reports no image digest (image {})".format(label, container, found.get("image") or "<none>"))
    elif running != digest:
        failures.append("{}: container {} runs {} and this release is {}".format(label, container, running, digest))
    else:
        print("{}: {} runs {} ({})".format(name, label, running, short(task.get("taskDefinitionArn"))))
if failures:
    print("FAIL: {} is not running this release (deployment {}, rollout {}):".format(
        name, short(definition), primary.get("rolloutState") or "unknown"), file=sys.stderr)
    for failure in failures:
        print("      " + failure, file=sys.stderr)
    sys.exit(1)
if expected == 0:
    print("{}: the root declares no task, and none runs".format(name))
'
}

# The registered task definition, as JSON (FSS_RELEASE_TASK_DEFINITION answers offline).
release_task_definition() {
  local environment=$1 task_definition_arn=$2
  if [ "${FSS_RELEASE_TASK_DEFINITION+set}" = "set" ]; then
    printf '%s' "${FSS_RELEASE_TASK_DEFINITION}"
    return 0
  fi
  if rehearsal_dry_run; then
    release_plan_note "aws ecs describe-task-definition --task-definition $task_definition_arn --query taskDefinition"
    return 0
  fi
  release_aws "$environment" ecs describe-task-definition --task-definition "$task_definition_arn" \
    --query 'taskDefinition' --output json
}

# The pre-launch judgement over one container: the image is the release digest, and the
# database host and credential entry are the ones this release names.
#   release_guard_task_definition <definition json> <container> <digest> <database host> <secret arn>
release_guard_task_definition() {
  local definition=$1 container=$2 expected_digest=$3 expected_host=$4 expected_secret=$5
  local image host secret
  { IFS= read -r image; IFS= read -r host; IFS= read -r secret; } < <(FSS_JSON="$definition" FSS_NAME="$container" python3 -c '
import json, os
entry = next((e for e in (json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("containerDefinitions") or []
              if e.get("name") == os.environ["FSS_NAME"]), {})
host = next((str(v.get("value", "")) for v in entry.get("environment") or [] if v.get("name") == "FSS_DATABASE_HOST"), "")
secret = next((str(r.get("valueFrom", "")) for r in entry.get("secrets") or [] if r.get("name") == "DATABASE_SECRET_ARN"), "")
print(str(entry.get("image", "")))
print(host)
print(secret)
')
  if [ -z "$image" ]; then
    echo "FAIL: the task definition has no container named '$container'" >&2
    return 1
  fi
  case "$image" in
    *"@$expected_digest") ;;
    *)
      echo "FAIL: the task definition's image is not the release digest." >&2
      echo "      registered: $image" >&2
      echo "      release:    $expected_digest" >&2
      return 1
      ;;
  esac
  if [ -n "$expected_host" ] && [ "$host" != "$expected_host" ]; then
    echo "FAIL: this task would connect to '$host' and the database this release targets is '$expected_host'." >&2
    return 1
  fi
  if [ -n "$expected_secret" ] && [ "$secret" != "$expected_secret" ]; then
    echo "FAIL: this task resolves its database credential from an entry this release did not name." >&2
    echo "      registered: ${secret:-<none>}" >&2
    echo "      expected:   $expected_secret" >&2
    return 1
  fi
}

# The network, against the root's own plan: its public subnets (no NAT gateway, so a
# task needs a public address to pull), the worker group, and zero inbound rules.
#   release_guard_network <plan json> <subnets csv> <security group> <assign public ip>
release_guard_network() {
  local plan=$1 subnets=$2 security_group=$3 assign_public_ip=$4
  local expected_csv expected_group expected_public inbound
  { IFS= read -r expected_csv; IFS= read -r expected_group; IFS= read -r expected_public; IFS= read -r inbound; } < <(FSS_JSON="$plan" python3 -c '
import json, os
plan = json.loads(os.environ["FSS_JSON"] or "{}") or {}
print(",".join(plan.get("subnet_ids") or []))
print(plan.get("security_group_id") or "")
print(plan.get("assign_public_ip") or "")
count = plan.get("inbound_rule_count")
print(-1 if count is None else count)
')
  if [ "$subnets" != "$expected_csv" ]; then
    echo "FAIL: the task would be launched into '$subnets' and this environment's public subnets are '$expected_csv'" >&2
    return 1
  fi
  if [ "$security_group" != "$expected_group" ]; then
    echo "FAIL: the task would run under '$security_group' and the worker security group is '$expected_group'" >&2
    return 1
  fi
  if [ "$assign_public_ip" != "$expected_public" ]; then
    echo "FAIL: assignPublicIp must be $expected_public; there is no NAT gateway, so a task without a public address cannot pull its image" >&2
    return 1
  fi
  if [ "$inbound" != "0" ]; then
    echo "FAIL: the worker security group declares $inbound inbound rule(s). A one-off task with a public address is only safe because that number is zero." >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Task records (lane g80). `tasks/<step>.arn` beside `tasks/<step>.fingerprint` means
# "launched by this invocation, outcome not read yet". A record is waited on only when
# its fingerprint is this invocation's; another run's record is refused while its task
# runs and set aside unread once it has stopped; a record is retired into
# `tasks/<step>.history` as soon as its outcome is read.
# ---------------------------------------------------------------------------

release_task_record_path() {
  local directory
  directory="$(rehearsal_report_dir)/tasks"
  mkdir -p "$directory"
  echo "$directory/$1.arn"
}

# FSS_RELEASE_RUN_ID, else the Actions run and attempt, else the reports directory.
release_run_id() {
  if [ -n "${FSS_RELEASE_RUN_ID:-}" ]; then
    printf '%s' "$FSS_RELEASE_RUN_ID"
  elif [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf 'github-%s-%s' "$GITHUB_RUN_ID" "${GITHUB_RUN_ATTEMPT:-1}"
  else
    printf 'local:%s' "$(rehearsal_report_dir)"
  fi
}

# `sha256:<hex>` over the fifteen fields that decide what a task does.
#   release_task_fingerprint <run> <environment> <prefix> <account> <region> <cluster> <step>
#     <task definition> <container> <image digest> <database host> <secret arn> <expect exit>
#     <command json> <override json>
release_task_fingerprint() {
  python3 -c '
import hashlib, json, sys
names = ("run", "environment", "prefix", "account", "region", "cluster", "step",
         "task_definition", "container", "image_digest", "database_host", "secret_arn",
         "expect_exit", "command", "overrides")
values = sys.argv[1:]
if len(values) != len(names):
    sys.exit("release_task_fingerprint takes {} fields, not {}".format(len(names), len(values)))
fields = dict(zip(names, values))
fields["command"] = json.loads(fields["command"])
fields["overrides"] = json.loads(fields["overrides"])
canonical = json.dumps({"schema": "fss.task-record.v1", **fields}, sort_keys=True, separators=(",", ":"))
print("sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest())
' "$@"
}

#   release_retire_task_record <record path> <outcome>
release_retire_task_record() {
  local record=$1 outcome=$2 base
  base=${record%.arn}
  [ -f "$record" ] || return 0
  printf '%s outcome=%s task=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$outcome" "$(head -n 1 "$record")" \
    "$(head -n 1 "$base.fingerprint" 2>/dev/null || echo 'fingerprint=<none: recorded before lane g80>')" \
    >> "$base.history"
  rm -f "$record" "$base.fingerprint"
}

# A record this invocation did not write: refuse while its task runs, else set it aside.
#   release_set_aside_task_record <environment> <cluster> <step> <record path> <recorded arn>
release_set_aside_task_record() {
  local environment=$1 cluster=$2 step=$3 record=$4 recorded_arn=$5 described status
  described="$(release_describe_task "$environment" "$cluster" "$recorded_arn")" || described=''
  if [ -z "$described" ]; then
    if rehearsal_dry_run; then
      rehearsal_plan "$step: $recorded_arn is recorded for another run or command; refuse while it is not STOPPED, otherwise set it aside unread and launch"
      release_retire_task_record "$record" "set_aside_unread_dry_run"
      return 0
    fi
    echo "FAIL: $step: $recorded_arn is recorded for another run or command, and ECS could not be asked whether it is still running. Nothing was launched beside it." >&2
    return 1
  fi
  status="$(release_json_path "$described" "tasks.0.lastStatus" "GONE")"
  if [ "$status" != "STOPPED" ] && [ "$status" != "GONE" ]; then
    echo "FAIL: $step: task $recorded_arn, recorded for another run or command, is still $status." >&2
    echo "      Launching beside it is how a second migration hides the first. Wait until it stops and run this again," >&2
    echo "      or, if it is this release's own task, resume it under the FSS_RELEASE_RUN_ID it was launched with (in $record.history or the log)." >&2
    return 1
  fi
  rehearsal_log "$step: $recorded_arn was recorded for another run or command and has stopped ($status); its outcome is set aside unread in ${record%.arn}.history, and this step launches its own"
  release_retire_task_record "$record" "set_aside_unread_$status"
}

# Succeeds, printing the reason, only for a STOPPED task no container of which reports an
# exit code and whose stop reason is CannotPullContainerError.
release_pull_failure() {
  local described=$1
  [ -n "$described" ] || return 1
  FSS_JSON="$described" python3 -c '
import json, os, sys
tasks = (json.loads(os.environ["FSS_JSON"]) or {}).get("tasks") or []
if not tasks or tasks[0].get("lastStatus") != "STOPPED":
    sys.exit(1)
task = tasks[0]
containers = task.get("containers") or []
if any(entry.get("exitCode") is not None for entry in containers):
    sys.exit(1)
for reason in [str(task.get("stoppedReason") or "")] + [str(entry.get("reason") or "") for entry in containers]:
    if "CannotPullContainerError" in reason:
        print(reason.strip())
        sys.exit(0)
sys.exit(1)
'
}

release_describe_task() {
  local environment=$1 cluster=$2 task_arn=$3
  if [ "${FSS_RELEASE_DESCRIBE_TASKS+set}" = "set" ]; then
    printf '%s' "${FSS_RELEASE_DESCRIBE_TASKS}"
    return 0
  fi
  if rehearsal_dry_run; then
    release_plan_note "aws ecs describe-tasks --cluster $cluster --tasks $task_arn"
    return 0
  fi
  command "$(rehearsal_aws_command)" ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --output json
}

# ---------------------------------------------------------------------------
# The one-off task runner.
#
# release_run_task --step <name> --environment <production|rehearsal> --prefix <prefix>
#                  --account <id> --region <region> --cluster <arn> --task-definition <arn>
#                  --container <name> --network-plan <json> --image-digest <sha256:...>
#                  [--database-host <host>] [--secret-arn <arn>] [--env NAME=VALUE]...
#                  [--log-group <name>] [--log-stream-prefix <prefix>] [--capture <file>]
#                  [--timeout-seconds <n>] [--expect-exit <code>] -- <command word>...
#
# Prints the task's log lines and returns non-zero unless every essential container
# exited with --expect-exit (default 0); a missing exit code is never a zero.
# ---------------------------------------------------------------------------
release_run_task() {
  local step='' environment='' prefix='' account='' region='' cluster='' task_definition=''
  local container='' network_plan='' image_digest='' database_host='' secret_arn=''
  local log_group='' log_stream_prefix='' capture='' expect_exit=0 field
  local timeout_seconds=$RELEASE_DEFAULT_TIMEOUT_SECONDS
  local -a command_words=() environment_overrides=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env) environment_overrides+=("$2"); shift 2 ;;
      --step) step=$2; shift 2 ;;
      --environment) environment=$2; shift 2 ;;
      --prefix) prefix=$2; shift 2 ;;
      --account) account=$2; shift 2 ;;
      --region) region=$2; shift 2 ;;
      --cluster) cluster=$2; shift 2 ;;
      --task-definition) task_definition=$2; shift 2 ;;
      --container) container=$2; shift 2 ;;
      --network-plan) network_plan=$2; shift 2 ;;
      --image-digest) image_digest=$2; shift 2 ;;
      --database-host) database_host=$2; shift 2 ;;
      --secret-arn) secret_arn=$2; shift 2 ;;
      --log-group) log_group=$2; shift 2 ;;
      --log-stream-prefix) log_stream_prefix=$2; shift 2 ;;
      --capture) capture=$2; shift 2 ;;
      --timeout-seconds) timeout_seconds=$2; shift 2 ;;
      --expect-exit) expect_exit=$2; shift 2 ;;
      --) shift; command_words=("$@"); break ;;
      *) echo "FAIL: release_run_task does not take '$1'" >&2; return 1 ;;
    esac
  done
  if [ "${#command_words[@]}" -eq 0 ]; then
    echo "FAIL: release_run_task needs a command after --. A one-off task with no command is the task definition's default, which is never what a caller meant." >&2
    return 1
  fi
  if ! [[ "$expect_exit" =~ ^[0-9]+$ ]]; then
    echo "FAIL: --expect-exit takes the exit code this step calls success, not '${expect_exit:-<empty>}'" >&2
    return 1
  fi
  for field in step environment prefix account region cluster task_definition container network_plan image_digest; do
    if [ -z "${!field}" ]; then
      echo "FAIL: release_run_task needs --${field//_/-}" >&2
      return 1
    fi
  done

  # The credentials, the namespace (the command words included), full ARNs, and the
  # cluster's own Environment tag.
  local caller_account tag
  caller_account="$(release_caller_account)"
  if [ -n "$caller_account" ] && [ "$caller_account" != "$account" ]; then
    echo "FAIL: these credentials belong to account $caller_account and this release is in $account" >&2
    return 1
  fi
  release_refuse_foreign_arguments "$environment" "${command_words[@]}" "$cluster" "$task_definition" || return 1
  release_require_arn "the cluster" "$cluster" ecs "$account" "$region" "$prefix" || return 1
  release_require_arn "the task definition" "$task_definition" ecs "$account" "$region" "$prefix" || return 1
  tag="$(release_cluster_environment_tag "$environment" "$cluster")"
  if [ -n "$tag" ] && [ "$tag" != "$environment" ]; then
    echo "FAIL: the cluster is tagged Environment=$tag and this is a $environment release" >&2
    return 1
  fi

  # An override may carry a public identifier and nothing else; FSS_DATABASE_HOST is how
  # a step reaches another endpoint while --database-host stays the definition's own.
  local override effective_host=$database_host override_name override_value
  for override in ${environment_overrides[@]+"${environment_overrides[@]}"}; do
    case "$override" in
      *=*) ;;
      *) echo "FAIL: --env takes NAME=VALUE, not '$override'" >&2; return 1 ;;
    esac
    override_name=${override%%=*}
    override_value=${override#*=}
    if printf '%s' "$override_name" | grep -qiE '(password|secret|token|credential|private_key|api_key)'; then
      echo "FAIL: '$override_name' looks like a credential. A secret reaches a task as a Secrets Manager reference the execution role resolves, never as an environment override: an override is visible in describe-tasks to anyone who can read the cluster." >&2
      return 1
    fi
    if [ "$override_name" = "FSS_DATABASE_HOST" ]; then effective_host=$override_value; fi
  done

  local definition
  definition="$(release_task_definition "$environment" "$task_definition")"
  if [ -n "$definition" ]; then
    release_guard_task_definition "$definition" "$container" "$image_digest" "$database_host" "$secret_arn" || return 1
    rehearsal_log "$step: target database host $effective_host"
  fi

  local subnets security_group
  subnets="$(release_json_path "$network_plan" "subnet_ids" "[]" | python3 -c '
import json, sys
sys.stdout.write(",".join(json.load(sys.stdin) or []))
')"
  security_group="$(release_json_path "$network_plan" "security_group_id")"
  release_guard_network "$network_plan" "$subnets" "$security_group" "ENABLED" || return 1

  local command_json override_json overrides network_configuration
  command_json="$(printf '%s\n' "${command_words[@]}" | python3 -c 'import json,sys; json.dump([line.rstrip("\n") for line in sys.stdin], sys.stdout)')"
  override_json="$(printf '%s\n' ${environment_overrides[@]+"${environment_overrides[@]}"} | python3 -c '
import json, sys
pairs = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if line:
        name, _, value = line.partition("=")
        pairs.append({"name": name, "value": value})
json.dump(pairs, sys.stdout)
')"
  overrides="$(FSS_CONTAINER="$container" FSS_COMMAND="$command_json" FSS_ENVIRONMENT="$override_json" python3 -c '
import json, os, sys
override = {"name": os.environ["FSS_CONTAINER"], "command": json.loads(os.environ["FSS_COMMAND"])}
environment = json.loads(os.environ["FSS_ENVIRONMENT"])
if environment:
    override["environment"] = environment
json.dump({"containerOverrides": [override]}, sys.stdout)
')"
  network_configuration="$(FSS_SUBNETS="$subnets" FSS_GROUP="$security_group" python3 -c '
import json, os, sys
json.dump({"awsvpcConfiguration": {"subnets": os.environ["FSS_SUBNETS"].split(","),
                                   "securityGroups": [os.environ["FSS_GROUP"]], "assignPublicIp": "ENABLED"}}, sys.stdout)
')"

  local record task_arn='' fingerprint_file run_id registered_definition fingerprint
  record="$(release_task_record_path "$step")"
  capture=${capture:-${record%.arn}.log}
  fingerprint_file=${record%.arn}.fingerprint
  run_id="$(release_run_id)"
  registered_definition="$(release_json_path "${definition:-}" "taskDefinitionArn" "$task_definition")"
  fingerprint="$(release_task_fingerprint "$run_id" "$environment" "$prefix" "$account" "$region" "$cluster" \
    "$step" "$registered_definition" "$container" "$image_digest" "$database_host" "$secret_arn" \
    "$expect_exit" "$command_json" "$override_json")"

  local attempt=1 attempts=$RELEASE_PULL_ATTEMPTS
  if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then attempts=1; fi
  while :; do
    task_arn=''
    if [ -s "$record" ]; then
      local recorded_arn recorded_fingerprint='' recorded_attempt
      recorded_arn="$(head -n 1 "$record")"
      if [ -s "$fingerprint_file" ]; then recorded_fingerprint="$(head -n 1 "$fingerprint_file" | cut -d ' ' -f 1)"; fi
      if [ "$recorded_fingerprint" = "$fingerprint" ]; then
        task_arn=$recorded_arn
        recorded_attempt="$(sed -n 's/.* attempt=\([0-9][0-9]*\).*/\1/p' "$fingerprint_file" | head -n 1)"
        if [ -n "$recorded_attempt" ]; then attempt=$recorded_attempt; fi
        rehearsal_log "$step: task $task_arn was launched for this step by this run ($run_id) and its outcome was never read; waiting on it rather than launching another"
      else
        release_set_aside_task_record "$environment" "$cluster" "$step" "$record" "$recorded_arn" || return 1
      fi
    fi
    if [ -z "$task_arn" ]; then
      local launched failure_count
      if rehearsal_dry_run; then
        rehearsal_plan "aws ecs run-task --cluster $cluster --task-definition $task_definition --launch-type FARGATE --network-configuration $network_configuration --overrides $overrides"
        launched="${FSS_RELEASE_RUN_TASK:-}"
      else
        launched="$(command "$(rehearsal_aws_command)" ecs run-task \
          --cluster "$cluster" --task-definition "$task_definition" --launch-type FARGATE \
          --network-configuration "$network_configuration" --overrides "$overrides" \
          --propagate-tags TASK_DEFINITION --output json)"
      fi
      # run-task answers 200 with a `failures` list and no task for capacity, subnet or
      # platform problems.
      failure_count="$(release_json_path "${launched:-}" "failures" "[]" | python3 -c 'import json,sys; print(len(json.load(sys.stdin) or []))')"
      if [ "$failure_count" -gt 0 ]; then
        echo "FAIL: $step was not started. ECS reported $failure_count failure(s):" >&2
        FSS_JSON="$launched" python3 -c '
import json, os, sys
for failure in json.loads(os.environ["FSS_JSON"]).get("failures") or []:
    print("  {} {}: {}".format(failure.get("arn", "<no arn>"), failure.get("reason", "<no reason>"), failure.get("detail", "")), file=sys.stderr)
'
        return 1
      fi
      task_arn="$(release_json_path "${launched:-}" "tasks.0.taskArn")"
      if [ -z "$task_arn" ]; then
        if rehearsal_dry_run; then
          rehearsal_plan "aws ecs wait tasks-stopped --cluster $cluster --tasks <task arn>"
          rehearsal_plan "aws ecs describe-tasks --cluster $cluster --tasks <task arn>"
          rehearsal_plan "read the essential container's exitCode; a missing one is a failure, never a zero"
          rehearsal_plan "a task stopped by CannotPullContainerError before any container ran is launched again, up to $attempts attempt(s), ${RELEASE_PULL_BACKOFF_SECONDS}s apart and growing; anything else fails at once"
          rehearsal_plan "aws logs get-log-events --log-group-name ${log_group:-<worker log group>} --log-stream-name ${log_stream_prefix:-<prefix>}/$container/<task id>"
          return 0
        fi
        echo "FAIL: $step reported neither a task nor a failure. Nothing was started and nothing said why." >&2
        return 1
      fi
      printf '%s\n' "$task_arn" > "$record"
      printf '%s run=%s task_definition=%s image_digest=%s attempt=%s\n' \
        "$fingerprint" "$run_id" "$registered_definition" "$image_digest" "$attempt" > "$fingerprint_file"
      rehearsal_log "$step: task $task_arn (recorded in $record; run $run_id; attempt $attempt of $attempts)"
    fi

    # The wait, with the caller's budget; a task still running at the end is stopped.
    local waited=0 status='' described
    while :; do
      described="$(release_describe_task "$environment" "$cluster" "$task_arn")"
      status="$(release_json_path "${described:-}" "tasks.0.lastStatus")"
      if [ "$status" = "STOPPED" ] || [ -z "$described" ]; then break; fi
      if [ "$waited" -ge "$timeout_seconds" ]; then
        echo "FAIL: $step was still $status after ${timeout_seconds}s. Stopping it rather than leaving it running." >&2
        release_aws "$environment" ecs stop-task --cluster "$cluster" --task "$task_arn" \
          --reason "release wrapper timeout after ${timeout_seconds}s" >/dev/null || true
        release_retire_task_record "$record" "timed_out_and_stopped"
        return 1
      fi
      sleep 10
      waited=$((waited + 10))
    done
    described="$(release_describe_task "$environment" "$cluster" "$task_arn")"

    # The image never arrived, so the application never started: launch again.
    local pull_reason=''
    if pull_reason="$(release_pull_failure "$described")"; then
      if [ "$attempt" -lt "$attempts" ]; then
        local pause=$((RELEASE_PULL_BACKOFF_SECONDS * attempt))
        rehearsal_log "$step: attempt $attempt of $attempts: task $task_arn stopped before any container ran, because its image could not be pulled ($pull_reason); launching again in ${pause}s"
        release_retire_task_record "$record" "image_not_pulled_attempt_$attempt"
        sleep "$pause"
        attempt=$((attempt + 1))
        continue
      fi
      echo "FAIL: $step: the image could not be pulled on any of $attempts attempt(s); the last said: $pull_reason" >&2
    fi

    # The verdict, then the log whatever the verdict, then the record retired.
    local verdict=0
    release_report_task "$step" "$described" "$container" "$expect_exit" || verdict=1
    release_print_task_logs "$environment" "$log_group" "$log_stream_prefix" "$container" "$task_arn" "$capture"
    release_retire_task_record "$record" "read_verdict_$verdict"
    return "$verdict"
  done
}

# The last JSON object a command printed on stdout, out of the captured log lines (a
# log line carries `level` and `event`; the answer never does).
#   release_captured_report <captured file> <destination>
release_captured_report() {
  local captured=$1 destination=$2
  if [ ! -s "$captured" ]; then
    echo "FAIL: nothing was captured from the task's log stream, so its report cannot be read." >&2
    return 1
  fi
  if ! FSS_CAPTURED="$captured" FSS_DESTINATION="$destination" python3 -c '
import json, os, sys
found = None
for line in open(os.environ["FSS_CAPTURED"], encoding="utf-8"):
    text = line.strip()
    if not text.startswith("{"):
        continue
    try:
        candidate = json.loads(text)
    except ValueError:
        continue
    if isinstance(candidate, dict) and "level" in candidate and "event" in candidate:
        continue
    found = candidate
if found is None:
    sys.exit(1)
with open(os.environ["FSS_DESTINATION"], "w", encoding="utf-8") as handle:
    json.dump(found, handle, indent=2)
    handle.write("\n")
'; then
    echo "FAIL: the task printed no JSON report on stdout; see the log lines above." >&2
    return 1
  fi
  rehearsal_log "report read from the task's log stream into $destination"
}

# Every essential container's exit code against the step's expected one, and the stop
# reason either way. A stopped task with no exit code is a failure with its own message.
release_report_task() {
  local step=$1 described=$2 container=$3 expected=${4:-0}
  if [ -z "$described" ]; then
    rehearsal_log "$step: no task description available (dry run)"
    return 0
  fi
  local verdict line kind detail failed=0
  verdict="$(FSS_JSON="$described" FSS_CONTAINER="$container" python3 -c '
import json, os
tasks = json.loads(os.environ["FSS_JSON"]).get("tasks") or []
if not tasks:
    print("no_task|the task disappeared between launch and description")
    raise SystemExit(0)
task = tasks[0]
stopped_reason = task.get("stoppedReason") or "<none>"
print("info|stopCode={} stoppedReason={}".format(task.get("stopCode") or "<none>", stopped_reason))
containers = task.get("containers") or []
if not containers:
    print("no_containers|the task stopped with no container at all: {}".format(stopped_reason))
    raise SystemExit(0)
worst = 0
for entry in containers:
    name, code, reason = entry.get("name"), entry.get("exitCode"), entry.get("reason") or ""
    if code is None:
        print("missing_exit_code|container {} stopped with no exit code. {} {}".format(name, stopped_reason, reason))
        raise SystemExit(0)
    print("info|container {} exited {} {}".format(name, code, reason).rstrip())
    if int(code) != 0:
        worst = int(code)
print("exit|{}".format(worst))
')"
  while IFS= read -r line; do
    kind=${line%%|*}
    detail=${line#*|}
    case "$kind" in
      info) rehearsal_log "$step: $detail" ;;
      exit)
        if [ "$detail" = "$expected" ]; then
          if [ "$expected" != "0" ]; then rehearsal_log "$step: exited $detail, which is the code this step requires"; fi
        elif [ "$expected" = "0" ]; then
          echo "FAIL: $step exited $detail" >&2
          failed=1
        else
          echo "FAIL: $step exited $detail and this step requires exit $expected" >&2
          failed=1
        fi
        ;;
      *) echo "FAIL: $step — $detail" >&2; failed=1 ;;
    esac
  done <<<"$verdict"
  return "$failed"
}

# The task's log stream: waited for while it does not exist or is still empty (the
# awslogs driver delivers a stopped container's last lines a few seconds late), only the
# `message` of each event printed, and the same lines written to <capture>.
release_print_task_logs() {
  local environment=$1 log_group=$2 stream_prefix=$3 container=$4 task_arn=$5 capture=${6:-}
  if [ -z "$log_group" ] || [ -z "$stream_prefix" ]; then
    rehearsal_log "$container: no log group or stream prefix was given, so the task's own output is not shown" >&2
    return 0
  fi
  local stream events waited=0 status
  stream="${stream_prefix}/${container}/${task_arn##*/}"
  while :; do
    if [ "${FSS_RELEASE_LOG_EVENTS+set}" = "set" ]; then
      events=${FSS_RELEASE_LOG_EVENTS}
    elif rehearsal_dry_run; then
      rehearsal_plan "aws logs get-log-events --log-group-name $log_group --log-stream-name $stream --start-from-head"
      return 0
    else
      set +e
      events="$(command "$(rehearsal_aws_command)" logs get-log-events \
        --log-group-name "$log_group" --log-stream-name "$stream" --start-from-head --output json 2>&1)"
      status=$?
      set -e
      if [ "$status" -ne 0 ]; then
        case "$events" in
          *ResourceNotFoundException*)
            if [ "$waited" -ge "$RELEASE_LOG_GRACE_SECONDS" ]; then
              rehearsal_log "no log stream $stream after ${RELEASE_LOG_GRACE_SECONDS}s; the task produced no output CloudWatch kept" >&2
              return 0
            fi
            sleep "$RELEASE_LOG_POLL_SECONDS"
            waited=$((waited + RELEASE_LOG_POLL_SECONDS))
            continue
            ;;
          *)
            printf '%s\n' "$events" >&2
            rehearsal_log "the log stream could not be read, and not because it does not exist" >&2
            return 0
            ;;
        esac
      fi
      if [ "$(FSS_JSON="${events:-null}" python3 -c 'import json, os; print(len((json.loads(os.environ["FSS_JSON"]) or {}).get("events") or []))')" = "0" ]; then
        if [ "$waited" -lt "$RELEASE_LOG_GRACE_SECONDS" ]; then
          sleep "$RELEASE_LOG_POLL_SECONDS"
          waited=$((waited + RELEASE_LOG_POLL_SECONDS))
          continue
        fi
        rehearsal_log "log stream $stream in $log_group held no events after ${RELEASE_LOG_GRACE_SECONDS}s" >&2
        return 0
      fi
    fi
    break
  done
  rehearsal_log "$container: log stream $stream in $log_group${capture:+ (kept in $capture)}"
  FSS_JSON="${events:-null}" FSS_CAPTURE="$capture" python3 -c '
import json, os
capture = os.environ["FSS_CAPTURE"]
handle = open(capture, "w", encoding="utf-8") if capture else None
for event in (json.loads(os.environ["FSS_JSON"]) or {}).get("events") or []:
    message = str(event.get("message", "")).rstrip()
    print("  " + message)
    if handle is not None:
        handle.write(message + "\n")
if handle is not None:
    handle.close()
'
}

# ---------------------------------------------------------------------------
# A standing stack, read from its root (deploy.sh and stop.sh)
# ---------------------------------------------------------------------------

# The root's outputs a release step reads, as globals. Refuses a root that is not the
# prefix's environment: a production root under a rehearsal prefix would read a
# rehearsal plan and act on production, and the reverse would point CI at production.
# With a named environment and a phrase, release_require_named_environment runs before
# anything is read.
#   release_read_root <root> <prefix> [<named environment> <what the step does>]
release_read_root() {
  ROOT_DIRECTORY=$1
  PREFIX=$2
  ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")" || exit 1
  case "$ENVIRONMENT:$ROOT_DIRECTORY" in
    production:*roots/production | rehearsal:*roots/rehearsal) ;;
    *) echo "FAIL: prefix '$PREFIX' is a $ENVIRONMENT prefix and '$ROOT_DIRECTORY' is not the $ENVIRONMENT root." >&2; exit 1 ;;
  esac
  [ "$#" -lt 4 ] || release_require_named_environment "$3" "$4"
  CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
  MIGRATION_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" migration_task_definition_arn)"
  OPERATIONS_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
  RUNTIME_SECRET_ARN="$(release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn)"
  NETWORK_PLAN="$(release_output "$ROOT_DIRECTORY" task_network_configuration json)"
  DEPLOYMENT_PLAN="$(release_output "$ROOT_DIRECTORY" deployment_plan json)"
  LOG_GROUP="$(release_output "$ROOT_DIRECTORY" worker_log_group_name)"
  DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"
  API_SERVICE="$(release_json_path "${DEPLOYMENT_PLAN:-}" "api.service_name" "${PREFIX}-api")"
  WORKER_SERVICE="$(release_json_path "${DEPLOYMENT_PLAN:-}" "worker.service_name" "${PREFIX}-worker")"
  API_TARGET="$(release_json_path "${DEPLOYMENT_PLAN:-}" "api.declared_desired_count" "1")"
  WORKER_TARGET="$(release_json_path "${DEPLOYMENT_PLAN:-}" "worker.declared_desired_count" "1")"
  BOOTSTRAP="$(release_json_path "${DEPLOYMENT_PLAN:-}" "bootstrap" "false")"
  ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
  REGION="${AWS_REGION:-us-east-1}"
}

# Before the first call that changes a service: the credentials are this release's
# account, the cluster is a full ARN in this account, region and namespace, both service
# names are this environment's, nothing names the other one, and the cluster's own
# Environment tag agrees.   release_guard_services <what this is, for the message>
release_guard_services() {
  local what=$1 caller tag service
  if [ -n "${FSS_RELEASE_ACCOUNT:-}" ]; then
    caller="$(release_caller_account)"
    if [ -n "$caller" ] && [ "$caller" != "$ACCOUNT" ]; then
      echo "FAIL: these credentials belong to account $caller and this release is in $ACCOUNT" >&2
      exit 1
    fi
  fi
  # A dry run with no fixture has no ARN to judge, and says so rather than inventing one.
  if [ -n "$CLUSTER_ARN" ] || ! rehearsal_dry_run; then
    release_require_arn "the cluster" "$CLUSTER_ARN" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
  fi
  for service in "$API_SERVICE" "$WORKER_SERVICE"; do
    case "$service" in
      "$PREFIX"-*) ;;
      *) echo "FAIL: '$service' is not a service of $PREFIX" >&2; exit 1 ;;
    esac
  done
  release_refuse_foreign_arguments "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" "$WORKER_SERVICE" || exit 1
  tag="$(release_cluster_environment_tag "$ENVIRONMENT" "$CLUSTER_ARN")"
  if [ -n "$tag" ] && [ "$tag" != "$ENVIRONMENT" ]; then
    echo "FAIL: the cluster is tagged Environment=$tag and this is a $ENVIRONMENT $what" >&2
    exit 1
  fi
  rehearsal_log "cluster $CLUSTER_ARN"
}

# Production is named out loud (--environment production) by a step that takes it down
# or writes its first rows; a rehearsal may name itself, and neither may name the other.
#   release_require_named_environment <named> <what the step does, for the message>
release_require_named_environment() {
  local named=$1 what=$2
  if [ -n "$named" ] && [ "$named" != "$ENVIRONMENT" ]; then
    echo "FAIL: --environment $named was given and '$PREFIX' is a $ENVIRONMENT prefix." >&2
    exit 1
  fi
  if [ "$ENVIRONMENT" = production ] && [ "$named" != production ]; then
    echo "FAIL: '$PREFIX' is the production namespace and this command $what." >&2
    echo "      So production is named out loud or not at all: re-run with --environment production." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# The release record put (lane g71; before the rollout since 26 September 2026)
# ---------------------------------------------------------------------------

# The record file as standard base64 for a one-off task's argument, refused unless it is
# an fss.release-record.v1 with a reference, at most 6000 characters encoded, and names
# the given digests (an empty digest is not compared).
#   release_record_base64 <file> <api digest> <worker digest>
release_record_base64() {
  local file=$1 api=${2:-} worker=${3:-} encoded problem
  if [ ! -r "$file" ]; then
    echo "FAIL: --release-record names '$file', which cannot be read. Pass the release-record.json record.sh from-ci wrote." >&2
    return 1
  fi
  if ! encoded="$(FSS_RECORD="$file" python3 -c '
import base64, json, os, sys
raw = open(os.environ["FSS_RECORD"], "rb").read()
record = json.loads(raw)
if not isinstance(record, dict) or record.get("schema") != "fss.release-record.v1":
    sys.exit("the file is not an fss.release-record.v1")
if not str(record.get("releaseGateReference", "")):
    sys.exit("the record carries no releaseGateReference")
encoded = base64.b64encode(raw).decode("ascii")
if len(encoded) > 6000:
    sys.exit("the record is too large to hand to a one-off task as an argument")
sys.stdout.write(encoded)
')"; then
    echo "FAIL: --release-record '$file' is not a release record this script can hand to the task." >&2
    return 1
  fi
  problem="$(FSS_RECORD="$file" FSS_API="$api" FSS_WORKER="$worker" python3 -c '
import json, os
artifacts = json.load(open(os.environ["FSS_RECORD"], "rb")).get("artifacts") or {}
problems = []
for name, variable in (("api", "FSS_API"), ("worker", "FSS_WORKER")):
    given = os.environ[variable]
    if given and artifacts.get(name) != given:
        problems.append("{} {} (this release: {})".format(name, artifacts.get(name), given))
print("; ".join(problems))
')"
  if [ -n "$problem" ]; then
    echo "FAIL: --release-record '$file' names $problem. Build the record for the digests being released (release.md 4.2)." >&2
    return 1
  fi
  printf '%s' "$encoded"
}

# `fss admin release-record put` on the operations task, held to <operations digest>, and
# the stored answer printed and held to the record: `created` or `existing`, and the same
# reference, source, suite and digests. Sets RELEASE_RECORD_OUTCOME.
#   release_record_put <step> <record file> <environment> <prefix> <account> <region>
#     <cluster> <operations task definition> <operations digest> <network plan>
#     <database host> <secret arn> <log group>
RELEASE_RECORD_OUTCOME=none
release_record_put() {
  local step=$1 file=$2 environment=$3 prefix=$4 account=$5 region=$6 cluster=$7
  local task_definition=$8 digest=$9 network_plan=${10} database_host=${11} secret_arn=${12} log_group=${13}
  local reports encoded reference
  reports="$(rehearsal_report_dir)"
  mkdir -p "$reports"
  encoded="$(release_record_base64 "$file" "" "")" || return 1
  reference="$(FSS_RECORD="$file" python3 -c 'import json, os; print(json.load(open(os.environ["FSS_RECORD"], "rb"))["releaseGateReference"])')"
  rehearsal_log "$step: fss admin release-record put --json-base64 \"\$RELEASE_RECORD_BASE64\" --report /tmp/fss-release-record.json (the record $reference in $file)"
  release_run_task \
    --step "$step" --environment "$environment" --prefix "$prefix" --account "$account" --region "$region" \
    --cluster "$cluster" --task-definition "$task_definition" --container operations \
    --network-plan "$network_plan" --image-digest "$digest" \
    --database-host "$database_host" --secret-arn "$secret_arn" \
    --log-group "$log_group" --log-stream-prefix operations --capture "$reports/$step.log" \
    -- admin release-record put --json-base64 "$encoded" --report /tmp/fss-release-record.json \
    || { echo "FAIL: the operations task did not put the release record $reference" >&2; return 1; }
  if rehearsal_dry_run; then
    rehearsal_plan "read the task's log stream, print the put's answer from $reports/$step.json, and require created or existing for the record $reference"
    RELEASE_RECORD_OUTCOME=planned
    return 0
  fi
  release_captured_report "$reports/$step.log" "$reports/$step.json" \
    || { echo "FAIL: the put's answer could not be read from the operations task's log" >&2; return 1; }
  rehearsal_log "release record stored:"
  cat "$reports/$step.json"
  RELEASE_RECORD_OUTCOME="$(FSS_FILE="$reports/$step.json" FSS_RECORD="$file" python3 -c '
import json, os, sys
answer = json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}
record = json.load(open(os.environ["FSS_RECORD"], "rb"))
if answer.get("outcome") not in ("created", "existing"):
    sys.exit("the put answered {} ({}): {}".format(answer.get("outcome"), answer.get("reason"), answer.get("detail")))
artifacts = record.get("artifacts") or {}
expected = {"reference": record.get("releaseGateReference"), "source": record.get("source") or "rehearsal",
            "suite": record.get("suite"), "apiDigest": artifacts.get("api"), "workerDigest": artifacts.get("worker")}
different = [key for key, value in expected.items() if answer.get(key) != value]
if different:
    sys.exit("the stored record differs from the one put in {}".format(", ".join(different)))
print(answer["outcome"])
')" || { echo "FAIL: $step: the operations task did not store the release record $reference as it was put (above)." >&2; return 1; }
}
