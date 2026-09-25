#!/usr/bin/env bash
# Running one command inside the VPC, safely, in either environment (lane G12h).
#
# Sourced, never executed.
#
# ## Why this file exists
#
# The database is private: `infra/modules/database` sets `publicly_accessible = false`
# for every instance, there is no NAT gateway and no interface endpoint, and both
# binaries refuse to start unless the applied schema version is exactly the range they
# declare. So on a fresh environment nothing can migrate the database and nothing can
# check it, in rehearsal or in production, and the only thing already inside the VPC
# that can reach PostgreSQL is the worker image. David chose Option A on 21 September:
# database work runs as one-off ECS tasks using that image.
#
# `aws ecs run-task` is four calls and about a dozen ways to be told nothing useful.
# Everything below is one of those ways, written down once:
#
#   * a `failures` array instead of a task;
#   * a task that never started, so `tasks` is empty;
#   * a task that stopped with no `exitCode` at all, which is not a zero;
#   * `stoppedReason` and `stopCode`, which are the only explanation of a pull error;
#   * a log stream that does not exist yet when the task has already stopped;
#   * a wait that times out, leaving a task running and a script that walked away;
#   * a non-essential container's exit code read as if it were the task's;
#   * an image the registry does not serve yet, minutes after it was copied there,
#     which stops the task before any container runs (lane g80: launched again, a
#     bounded number of times, and nothing else is);
#   * a task recorded by another release, run or command, whose verdict is not this
#     step's (lane g80: the record carries a fingerprint and is retired once read).
#
# ## One code path, two environments
#
# David's decision: production applies stay local and are run by him, and the rehearsal
# runs in CI — but they run *the same script*. So this file is environment-neutral and
# the refusal is symmetric: in a rehearsal no argument may name `fss-prod`, and in
# production no argument may name `fss-rh-`. `infra/scripts/rehearsal-common.sh` is
# sourced for the first half, because that refusal, the dry-run mode and the reports
# directory already exist there and a second copy of them is a second set of rules.
#
# ## Offline
#
# Every AWS response this file reads can be supplied through an `FSS_RELEASE_*`
# variable instead of being fetched, which is how `test/release/scenario43.check.ts`
# exercises each refusal without a credential, and how the release workflow's dry run
# reaches every branch. Nothing here ever prints an environment variable's value, a
# connection string or a secret, including inside an error.

# shellcheck source=infra/scripts/rehearsal-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

# The one production namespace, and the shape a rehearsal run's namespace takes.
RELEASE_PRODUCTION_PREFIX='fss-prod'
RELEASE_REHEARSAL_PREFIX_PATTERN='^fss-rh-[a-z0-9-]{3,18}$'

# How long a one-off task may take before the wrapper stops it and fails. A migration
# under the advisory lock is the long one; 20 minutes is generous and finite, and a
# wrapper with no budget is a workflow that hangs until the job timeout with no
# explanation of which step it was in.
RELEASE_DEFAULT_TIMEOUT_SECONDS=1200

# How long to keep asking for a log stream that has not appeared yet. A task that
# stops quickly can be described before its stream exists, and treating that as "no
# output" loses exactly the message that says why it stopped.
RELEASE_LOG_GRACE_SECONDS=60
# How long to wait between looks at a log stream that exists but is still empty. The
# awslogs driver delivers a stopped container's last lines a few seconds after ECS
# reports it stopped; the two runs of 23 September 2026 read the stream in that gap and
# printed nothing, and the teardown then destroyed the log group with the answer in it.
RELEASE_LOG_POLL_SECONDS=${RELEASE_LOG_POLL_SECONDS:-5}

# How many times a one-off task whose image could not be pulled is launched, and the
# pause before the next launch, which grows with each attempt (30 s, then 60 s). Lane
# g80, audit item O06: a `CannotPullContainerError ... not found` a few minutes after
# an ECR copy is a registry that has not caught up yet, not a release that is wrong,
# and it used to need a person to clear the record and start the step again. Only a
# failure that provably happened before the application started is retried — see
# `release_pull_failure` — and anything else still fails on the first attempt.
RELEASE_PULL_ATTEMPTS=${RELEASE_PULL_ATTEMPTS:-3}
RELEASE_PULL_BACKOFF_SECONDS=${RELEASE_PULL_BACKOFF_SECONDS:-30}

# A plan line from a helper whose *stdout is the answer*.
#
# `rehearsal_plan` writes to stdout, which is right for a command whose only output
# is the plan and wrong for `release_output`, whose caller does
# `x="$(release_output …)"`. A plan line there becomes the value, and the first
# version of this file duly reported `the cluster is tagged Environment=PLAN aws ecs
# describe-clusters …`. So value-returning helpers say what they would have run on
# stderr and return nothing, and the workflow's plan step captures both streams.
release_plan_note() {
  printf 'PLAN %s\n' "$*" >&2
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

# Which environment a name prefix belongs to. Refuses anything that is neither.
#
#   release_environment_for_prefix fss-prod        -> production
#   release_environment_for_prefix fss-rh-0921     -> rehearsal
release_environment_for_prefix() {
  local prefix=${1:-}
  if [ "$prefix" = "$RELEASE_PRODUCTION_PREFIX" ]; then
    echo production
    return 0
  fi
  if [[ "$prefix" =~ $RELEASE_REHEARSAL_PREFIX_PATTERN ]]; then
    echo rehearsal
    return 0
  fi
  echo "FAIL: '${prefix:-<empty>}' is neither the production prefix (${RELEASE_PRODUCTION_PREFIX}) nor a rehearsal prefix (${RELEASE_REHEARSAL_PREFIX_PATTERN})" >&2
  return 1
}

# The symmetric refusal. A rehearsal command may not name production, and — the half
# that did not exist before G12h — a production command may not name a rehearsal run.
# The second direction matters because the same script now runs in both: a production
# deploy that picked up a rehearsal cluster ARN from a stale shell would otherwise
# scale a rehearsal service and report success.
release_refuse_foreign_arguments() {
  local environment=$1 argument
  shift
  case "$environment" in
    rehearsal)
      rehearsal_refuse_production_arguments "$@" || return 1
      ;;
    production)
      for argument in "$@"; do
        case "$argument" in
          *fss-rh-*)
            echo "FAIL: a production command names a rehearsal resource: $argument" >&2
            return 1
            ;;
        esac
      done
      ;;
    *)
      echo "FAIL: '$environment' is not an environment this script knows" >&2
      return 1
      ;;
  esac
  return 0
}

# Every AWS call a release command makes. Same shape as `rehearsal_aws`, with the
# refusal chosen by environment.
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

# `terraform output` from a root, without a chdir the caller has to remember.
#
#   release_output infra/roots/rehearsal deployment_plan json
#
# Dry mode prints the plan line and echoes the caller's fixture, so a dry run reaches
# the same code with the same shapes rather than a different branch.
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
  if [ "$form" = "json" ]; then
    command "${TERRAFORM:-terraform}" -chdir="$root" output -json "$name"
  else
    command "${TERRAFORM:-terraform}" -chdir="$root" output -raw "$name"
  fi
}

# ---------------------------------------------------------------------------
# Small JSON readers. `python3` rather than `jq`, because every other script in
# this directory already depends on python3 and none of them depends on jq.
# ---------------------------------------------------------------------------

# release_json_path <json> <dotted.path> [default]
release_json_path() {
  FSS_JSON="$1" FSS_PATH="$2" FSS_DEFAULT="${3-}" python3 -c '
import json, os, sys

value = json.loads(os.environ["FSS_JSON"] or "null")
for part in os.environ["FSS_PATH"].split("."):
    if value is None:
        break
    if part.isdigit() and isinstance(value, list):
        index = int(part)
        value = value[index] if index < len(value) else None
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
# The guards that run before anything is launched.
#
# Each one is separately callable, because each one is separately testable, and
# because a guard that only exists inside a 200-line function is a guard nobody can
# show you failing.
# ---------------------------------------------------------------------------

# An ARN, in this account, in this region, in this namespace.
#
#   release_require_arn <what> <arn> <service> <expected account> <expected region> <prefix>
#
# A bare name is refused on purpose. `aws ecs run-task --cluster fss-rh-0921-cluster`
# resolves against whatever region and account the ambient credentials happen to be,
# which is the one thing a release must not leave to the environment.
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
    *)
      echo "FAIL: $what does not carry this environment's namespace ($prefix): $arn" >&2
      return 1
      ;;
  esac
  return 0
}

# The account the credentials in this shell actually belong to.
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

# The cluster's own `Environment` tag, which is what `infra/modules/stack` sets and
# what says out loud which of the two this is.
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

# A service's counts, as three words: `desired running pending` (lane g70).
#
#   release_service_counts <environment> <cluster arn> <service name>
#
# What `release-stop.sh` waits for and what `release-deploy.sh --schema-change` refuses
# without. Read from `describe-services` rather than from Terraform, because the whole
# point is the count ECS is running *now*, and Terraform no longer tracks it after the
# first apply (`ignore_changes = [desired_count]` in `infra/modules/cluster`).
#
# A service ECS does not know, or knows as anything but `ACTIVE`, is a refusal rather
# than a zero: "there is nothing running" and "this is not the service I meant" must not
# be the same answer. `FSS_RELEASE_SERVICES` supplies the response offline; in dry-run
# mode without it this prints the call on stderr and nothing on stdout, and the caller
# reads the empty answer as "not judged" — never as a pass outside dry-run mode.
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

# Refuse unless a service is at zero on all three counts.
#
#   release_require_service_stopped <environment> <cluster arn> <service name>
#
# Desired zero is what an operator asked for; running and pending zero are what ECS has
# actually done. A task still starting is a process about to read the schema.
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
  return 0
}

# Refuse unless a service is running exactly the release's image (lane g80, audit O08).
#
#   release_require_running_digest <environment> <cluster arn> <service> <container>
#                                  <image digest> <declared count>
#
# `aws ecs wait services-stable` says that one deployment has as many running tasks as
# it wants. It does not say which deployment: the circuit breaker on both services rolls
# a failed deployment back to the previous task definition, and a service that has
# rolled back is stable. So after every deploy the running tasks themselves are read
# and each is held to four things, or this fails naming what it found:
#
#   * the service is ACTIVE, has one deployment, and that deployment did not fail;
#   * exactly the declared number of tasks are RUNNING — a check over no tasks at all
#     is the vacuous pass, so zero running against a declared one is a failure;
#   * every running task belongs to that deployment's task definition;
#   * in every running task, the service's container (`api` or `worker`) reports the
#     image digest ECS actually pulled, and it is the digest this release names.
#
# Three read-only calls: describe-services, list-tasks, describe-tasks. Dry-run mode
# prints them and judges nothing.
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
    # One word per task ARN, which is what `--tasks` takes.
    # shellcheck disable=SC2086
    described="$(release_aws "$environment" ecs describe-tasks --cluster "$cluster" --tasks $arns --output json)" || return 1
  fi
  FSS_SERVICES="$services" FSS_TASKS="$described" FSS_NAME="$service" FSS_CONTAINER="$container" \
    FSS_DIGEST="$digest" FSS_EXPECTED="$expected" python3 -c '
import json, os, sys

name = os.environ["FSS_NAME"]
container = os.environ["FSS_CONTAINER"]
digest = os.environ["FSS_DIGEST"]
expected = int(os.environ["FSS_EXPECTED"])
failures = []

def short(arn):
    return str(arn or "<none>").rsplit("/", 1)[-1]

entry = None
for candidate in (json.loads(os.environ["FSS_SERVICES"] or "{}") or {}).get("services") or []:
    if candidate.get("serviceName") == name or str(candidate.get("serviceArn", "")).endswith("/" + name):
        entry = candidate
        break
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

tasks = [task for task in (json.loads(os.environ["FSS_TASKS"] or "{}") or {}).get("tasks") or [] if task.get("lastStatus") == "RUNNING"]
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

# The registered task definition, as JSON. Everything the launch is checked against —
# the image digest, the secret references, the database host — is read from here
# rather than from what the caller believes.
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

# The whole pre-launch judgement, over one container of one task definition.
#
#   release_guard_task_definition <definition json> <container> <image digest> <database host> <secret arn>
#
# The digest check is the release gate made real at the moment of use: the rehearsal
# passed on a digest, the record names that digest, and this refuses to run a task
# whose image is anything else. A tag cannot carry that comparison, which is why the
# image variables refuse one.
release_guard_task_definition() {
  local definition=$1 container=$2 expected_digest=$3 expected_host=$4 expected_secret=$5
  local image found

  found="$(release_json_path "$definition" "containerDefinitions" "[]")"
  image="$(FSS_JSON="$found" FSS_NAME="$container" python3 -c '
import json, os, sys
for entry in json.loads(os.environ["FSS_JSON"]) or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        sys.stdout.write(str(entry.get("image", "")))
        break
')"
  if [ -z "$image" ]; then
    echo "FAIL: the task definition has no container named '$container'" >&2
    return 1
  fi
  case "$image" in
    *"@$expected_digest") ;;
    *)
      # The image is a public identifier and naming it is the whole point of the check.
      echo "FAIL: the task definition's image is not the release digest." >&2
      echo "      registered: $image" >&2
      echo "      release:    $expected_digest" >&2
      return 1
      ;;
  esac

  local host secret
  host="$(FSS_JSON="$found" FSS_NAME="$container" python3 -c '
import json, os, sys
for entry in json.loads(os.environ["FSS_JSON"]) or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        for variable in entry.get("environment") or []:
            if variable.get("name") == "FSS_DATABASE_HOST":
                sys.stdout.write(str(variable.get("value", "")))
        break
')"
  if [ -n "$expected_host" ] && [ "$host" != "$expected_host" ]; then
    echo "FAIL: this task would connect to '$host' and the database this release targets is '$expected_host'." >&2
    return 1
  fi

  secret="$(FSS_JSON="$found" FSS_NAME="$container" python3 -c '
import json, os, sys
for entry in json.loads(os.environ["FSS_JSON"]) or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        for reference in entry.get("secrets") or []:
            if reference.get("name") == "DATABASE_SECRET_ARN":
                sys.stdout.write(str(reference.get("valueFrom", "")))
        break
')"
  if [ -n "$expected_secret" ] && [ "$secret" != "$expected_secret" ]; then
    # Two ARNs, both public identifiers. The *values* never appear anywhere.
    echo "FAIL: this task resolves its database credential from an entry this release did not name." >&2
    echo "      registered: ${secret:-<none>}" >&2
    echo "      expected:   $expected_secret" >&2
    return 1
  fi

  return 0
}

# The network a one-off task is launched into, asserted against the root's own output
# rather than against a literal.
#
#   release_guard_network <plan json> <subnets csv> <security group> <assign public ip>
#
# Public subnets and a public address because there is no NAT gateway and no interface
# endpoint: a task without one cannot pull its image. The worker security group
# because that is the group `infra/modules/network` already admits on 5432, and
# because it admits nothing inbound at all — which is what makes handing a one-off
# task a public address cost nothing.
release_guard_network() {
  local plan=$1 subnets=$2 security_group=$3 assign_public_ip=$4
  local expected_subnets expected_group expected_public inbound

  expected_subnets="$(release_json_path "$plan" "subnet_ids" "[]")"
  expected_group="$(release_json_path "$plan" "security_group_id")"
  expected_public="$(release_json_path "$plan" "assign_public_ip")"
  inbound="$(release_json_path "$plan" "inbound_rule_count" "-1")"

  local expected_csv
  expected_csv="$(FSS_JSON="$expected_subnets" python3 -c '
import json, os, sys
sys.stdout.write(",".join(json.loads(os.environ["FSS_JSON"]) or []))
')"

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
  return 0
}

# ---------------------------------------------------------------------------
# Recorded task ARNs, so a retry waits rather than launching a second copy.
#
# A record is `tasks/<step>.arn` (the task ARN) beside `tasks/<step>.fingerprint`
# (what launched it), and it means one thing: *this task was launched and nobody has
# read how it ended*. Until lane g80 it meant "a task was once launched under this step
# name", keyed by the file name alone (audit item O07). A reports directory reused for
# another release, or a second run of the same script in one job, then read an old
# task's verdict as the new one's: the restore drill's step 7 runs
# `rehearsal-schema-ranges.sh` again after the restore, under the same four step names,
# and read the four tasks the first run had already judged instead of launching its
# own. And a failed task was reused for ever, including the `CannotPullContainerError`
# that nothing but a new launch can clear (O06).
#
# So now:
#
#   * the fingerprint is a SHA-256 over everything that decides what the task does —
#     the run, the environment, the account, the region, the cluster, the step, the
#     task definition with its revision (as ECS registered it), the container, the image
#     digest, the database host and credential entry, the command words, the
#     environment overrides and the exit code the step calls success;
#   * a record is waited on only when its fingerprint is this invocation's;
#   * a record with any other fingerprint, or none (a record written before g80), is
#     never read as this step's answer. If its task is still running this refuses,
#     because launching beside it is how a second migration hides the first; if it has
#     stopped it is set aside, unread, and this step launches its own;
#   * once a task's outcome has been read — a verdict, a timeout, a pull failure that
#     will be retried — the record is retired into `tasks/<step>.history`, so the next
#     invocation launches rather than re-reading a verdict somebody already acted on.
#
# The run is `release_run_id`: `FSS_RELEASE_RUN_ID` when the caller names one, the
# Actions run and attempt in CI, and otherwise the reports directory itself, which is
# what the documented production commands make fresh for every release.
# ---------------------------------------------------------------------------

release_task_record_path() {
  local step=$1 directory
  directory="$(rehearsal_report_dir)/tasks"
  mkdir -p "$directory"
  echo "$directory/${step}.arn"
}

# The run a record belongs to. Printed with every launch, and part of every fingerprint.
release_run_id() {
  if [ -n "${FSS_RELEASE_RUN_ID:-}" ]; then
    printf '%s' "$FSS_RELEASE_RUN_ID"
  elif [ -n "${GITHUB_RUN_ID:-}" ]; then
    printf 'github-%s-%s' "$GITHUB_RUN_ID" "${GITHUB_RUN_ATTEMPT:-1}"
  else
    printf 'local:%s' "$(rehearsal_report_dir)"
  fi
}

# release_task_fingerprint <run> <environment> <prefix> <account> <region> <cluster>
#                          <step> <task definition> <container> <image digest>
#                          <database host> <secret arn> <expect exit>
#                          <command json> <override json>
#
# `sha256:<hex>` over the canonical JSON of the fifteen fields, in this order. Nothing
# in it is a secret: ARNs, a digest, a hostname, command words and the overrides the
# wrapper has already refused anything credential-shaped in. Only the hash is stored.
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

# Retire a record whose outcome has been read, keeping one line of it in the history.
#
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

# A record this invocation did not write: refuse while its task runs, otherwise set it
# aside unread.
#
#   release_set_aside_task_record <environment> <cluster> <step> <record path> <recorded arn>
#
# "Stopped" includes a task ECS no longer describes at all: it forgets stopped tasks
# about an hour after they stop, and a task it cannot find is not running.
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
  return 0
}

# Print why a stopped task's image could not be pulled, and succeed, only when that is
# provably what happened before the application started: the task is STOPPED, no
# container reports an exit code (so no process ran), and ECS names a
# `CannotPullContainerError`. Anything else — an exit code, a secret that could not be
# resolved, capacity, a timeout — is not this, and fails on its first attempt.
#
#   release_pull_failure <describe-tasks json>
release_pull_failure() {
  local described=$1
  [ -n "$described" ] || return 1
  FSS_JSON="$described" python3 -c '
import json, os, sys

tasks = (json.loads(os.environ["FSS_JSON"]) or {}).get("tasks") or []
if not tasks:
    sys.exit(1)
task = tasks[0]
if task.get("lastStatus") != "STOPPED":
    sys.exit(1)
containers = task.get("containers") or []
if any(entry.get("exitCode") is not None for entry in containers):
    sys.exit(1)
reasons = [str(task.get("stoppedReason") or "")] + [str(entry.get("reason") or "") for entry in containers]
for reason in reasons:
    if "CannotPullContainerError" in reason:
        print(reason.strip())
        sys.exit(0)
sys.exit(1)
'
}

# ---------------------------------------------------------------------------
# The wrapper.
# ---------------------------------------------------------------------------

# release_run_task --step <name> --environment <production|rehearsal> --prefix <prefix>
#                  --account <id> --region <region>
#                  --cluster <arn> --task-definition <arn> --container <name>
#                  --network-plan <json> --image-digest <sha256:...>
#                  [--database-host <host>] [--secret-arn <arn>]
#                  [--log-group <name>] [--log-stream-prefix <prefix>]
#                  [--timeout-seconds <n>] [--expect-exit <code>]
#                  -- <command word>...
#
# Prints the task's log lines and returns the container's exit code. Returns non-zero
# for every one of the ways `run-task` can fail to tell you anything.
#
# `--expect-exit` is which code this step calls success, and it defaults to 0. It
# exists because one step's pass *is* a non-zero exit: Appendix G 22 launches a service
# image with a declared schema range it does not accept and the whole assertion is that
# the container refuses at startup with `configurationInvalid`
# (`infra/scripts/rehearsal-schema-ranges.sh`). The comparison belongs here, where the
# exit code is already read out of `describe-tasks`, rather than in a caller parsing
# this function's output.
release_run_task() {
  local step='' environment='' prefix='' account='' region=''
  local cluster='' task_definition='' container='' network_plan='' image_digest=''
  local database_host='' secret_arn='' log_group='' log_stream_prefix='' capture=''
  local expect_exit=0
  local timeout_seconds=$RELEASE_DEFAULT_TIMEOUT_SECONDS
  local -a command_words=()
  local -a environment_overrides=()

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
      *)
        echo "FAIL: release_run_task does not take '$1'" >&2
        return 1
        ;;
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

  # (a) and (b): the credentials in this shell, and the region they act in.
  local caller_account
  caller_account="$(release_caller_account)"
  if [ -n "$caller_account" ] && [ "$caller_account" != "$account" ]; then
    echo "FAIL: these credentials belong to account $caller_account and this release is in $account" >&2
    return 1
  fi

  # The command itself is an argument like any other, so the namespace refusal reads
  # it too: a `--report /tmp/fss-prod-...` path in a rehearsal is still a production
  # name, and a step that named one would be the guard doing nothing.
  release_refuse_foreign_arguments "$environment" "${command_words[@]}" "$cluster" "$task_definition" || return 1

  # (d): full ARNs, in this account, in this region, in this namespace.
  release_require_arn "the cluster" "$cluster" ecs "$account" "$region" "$prefix" || return 1
  release_require_arn "the task definition" "$task_definition" ecs "$account" "$region" "$prefix" || return 1

  # (c): the cluster says which environment it is, and it must agree.
  local tag
  tag="$(release_cluster_environment_tag "$environment" "$cluster")"
  if [ -n "$tag" ] && [ "$tag" != "$environment" ]; then
    echo "FAIL: the cluster is tagged Environment=$tag and this is a $environment release" >&2
    return 1
  fi

  # (h): an environment override may carry a public identifier and nothing else.
  #
  # The one this design needs is `FSS_DATABASE_HOST`, which is how the restored
  # instance's endpoint reaches a drill step (Appendix E; David's condition 4). An
  # endpoint is a hostname, and hostnames are public. A *credential* must never
  # travel this way: it arrives as a Secrets Manager reference the task resolves, so
  # that it is never an argument, never in `describe-tasks`, and never in a log.
  local override effective_host=$database_host
  for override in ${environment_overrides[@]+"${environment_overrides[@]}"}; do
    case "$override" in
      *=*) ;;
      *)
        echo "FAIL: --env takes NAME=VALUE, not '$override'" >&2
        return 1
        ;;
    esac
    local override_name=${override%%=*} override_value=${override#*=}
    if printf '%s' "$override_name" | grep -qiE '(password|secret|token|credential|private_key|api_key)'; then
      echo "FAIL: '$override_name' looks like a credential. A secret reaches a task as a Secrets Manager reference the execution role resolves, never as an environment override: an override is visible in describe-tasks to anyone who can read the cluster." >&2
      return 1
    fi
    if [ "$override_name" = "FSS_DATABASE_HOST" ]; then effective_host=$override_value; fi
  done

  # (e), (g): the digest, the database and the credential entry, read from the
  # registered definition rather than from what the caller believes.
  #
  # The definition's host is always compared with `--database-host`, which names the
  # host the definition was registered with — the primary. A drill step pointed at the
  # restored instance leaves `--database-host` at the primary and carries the restored
  # endpoint as the `FSS_DATABASE_HOST` override, which is what the container connects
  # to and what the log line names as the target. Until lane g48 an override that
  # differed from `--database-host` switched this comparison off, so a wrong
  # `--database-host` plus any override was accepted; and the drill passed the restored
  # endpoint as both, so the comparison ran against it and refused the one launch the
  # override exists for (run 35962272085, 24 September 2026).
  local definition
  definition="$(release_task_definition "$environment" "$task_definition")"
  if [ -n "$definition" ]; then
    release_guard_task_definition "$definition" "$container" "$image_digest" "$database_host" "$secret_arn" || return 1
    rehearsal_log "$step: target database host $effective_host"
  fi

  # (f): the network, against the root's own output.
  local subnets security_group
  subnets="$(release_json_path "$network_plan" "subnet_ids" "[]" | python3 -c '
import json, sys
sys.stdout.write(",".join(json.load(sys.stdin) or []))
')"
  security_group="$(release_json_path "$network_plan" "security_group_id")"
  release_guard_network "$network_plan" "$subnets" "$security_group" "ENABLED" || return 1

  local overrides command_json override_json
  command_json="$(printf '%s\n' "${command_words[@]}" | python3 -c 'import json,sys; json.dump([line.rstrip("\n") for line in sys.stdin], sys.stdout)')"
  override_json="$(printf '%s\n' ${environment_overrides[@]+"${environment_overrides[@]}"} | python3 -c '
import json, sys
pairs = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    name, _, value = line.partition("=")
    pairs.append({"name": name, "value": value})
json.dump(pairs, sys.stdout)
')"
  overrides="$(FSS_CONTAINER="$container" FSS_COMMAND="$command_json" FSS_ENVIRONMENT="$override_json" python3 -c '
import json, os, sys
override = {
    "name": os.environ["FSS_CONTAINER"],
    "command": json.loads(os.environ["FSS_COMMAND"]),
}
environment = json.loads(os.environ["FSS_ENVIRONMENT"])
if environment:
    override["environment"] = environment
json.dump({"containerOverrides": [override]}, sys.stdout)
')"

  local network_configuration
  network_configuration="$(FSS_SUBNETS="$subnets" FSS_GROUP="$security_group" python3 -c '
import json, os, sys
json.dump({"awsvpcConfiguration": {
    "subnets": os.environ["FSS_SUBNETS"].split(","),
    "securityGroups": [os.environ["FSS_GROUP"]],
    "assignPublicIp": "ENABLED",
}}, sys.stdout)
')"

  # (o): a recorded ARN means this step already launched and nobody has read how it
  # ended. Wait on that task rather than launching a second one — a retried job that
  # started two migrations would have the second one block on the advisory lock and
  # then apply nothing, which looks like success and is not.
  #
  # (p), lane g80 (audit O07): only a record this invocation would have written. See
  # "Recorded task ARNs" above for what the fingerprint covers and why a record is
  # retired once its outcome is read.
  local record task_arn=''
  record="$(release_task_record_path "$step")"
  # The log stream is the only thing of a one-off task that outlives it, and the
  # teardown destroys the log group minutes later. Keep a copy beside the task's ARN
  # unless the caller named its own capture file.
  capture=${capture:-${record%.arn}.log}
  local fingerprint_file=${record%.arn}.fingerprint
  local run_id registered_definition fingerprint
  run_id="$(release_run_id)"
  # The revision ECS registered, when the definition was read; the caller's ARN
  # otherwise. Terraform's outputs carry the revision already, and this makes the
  # fingerprint the registered one rather than the one the caller believes.
  registered_definition="$(release_json_path "${definition:-}" "taskDefinitionArn" "$task_definition")"
  fingerprint="$(release_task_fingerprint "$run_id" "$environment" "$prefix" "$account" "$region" "$cluster" \
    "$step" "$registered_definition" "$container" "$image_digest" "$database_host" "$secret_arn" \
    "$expect_exit" "$command_json" "$override_json")"

  # (q), lane g80 (audit O06): an image that could not be pulled is launched again, up
  # to RELEASE_PULL_ATTEMPTS times, and nothing else is.
  local attempt=1 attempts=$RELEASE_PULL_ATTEMPTS
  if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then attempts=1; fi
  while :; do
    task_arn=''
    if [ -s "$record" ]; then
      local recorded_arn recorded_fingerprint=''
      recorded_arn="$(head -n 1 "$record")"
      if [ -s "$fingerprint_file" ]; then recorded_fingerprint="$(head -n 1 "$fingerprint_file" | cut -d ' ' -f 1)"; fi
      if [ "$recorded_fingerprint" = "$fingerprint" ]; then
        task_arn=$recorded_arn
        # Resuming counts as the attempt it was, so the bound below stays a bound.
        local recorded_attempt
        recorded_attempt="$(sed -n 's/.* attempt=\([0-9][0-9]*\).*/\1/p' "$fingerprint_file" | head -n 1)"
        if [ -n "$recorded_attempt" ]; then attempt=$recorded_attempt; fi
        rehearsal_log "$step: task $task_arn was launched for this step by this run ($run_id) and its outcome was never read; waiting on it rather than launching another"
      else
        release_set_aside_task_record "$environment" "$cluster" "$step" "$record" "$recorded_arn" || return 1
      fi
    fi
    if [ -z "$task_arn" ]; then
      local launched
      if rehearsal_dry_run; then
        rehearsal_plan "aws ecs run-task --cluster $cluster --task-definition $task_definition --launch-type FARGATE --network-configuration $network_configuration --overrides $overrides"
        launched="${FSS_RELEASE_RUN_TASK:-}"
      else
        launched="$(command "$(rehearsal_aws_command)" ecs run-task \
          --cluster "$cluster" \
          --task-definition "$task_definition" \
          --launch-type FARGATE \
          --network-configuration "$network_configuration" \
          --overrides "$overrides" \
          --propagate-tags TASK_DEFINITION \
          --output json)"
      fi

      # (i): the `failures` array. `run-task` returns 200 with an empty `tasks` list and
      # a populated `failures` list for a capacity problem, a bad subnet or a missing
      # platform version, and a caller reading only the exit code sees success.
      local failure_count
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
      # (j): no failures and no task. It happens, and "nothing to wait for" must not be
      # read as "nothing went wrong".
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

    # (k): the wait, with a budget. `aws ecs wait tasks-stopped` polls for up to 100
    # attempts at 6 seconds, which is 10 minutes and not always enough; this is the
    # budget the caller declared, and a task still running at the end of it is stopped
    # rather than abandoned.
    local waited=0 status=''
    while :; do
      local described
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

    local described
    described="$(release_describe_task "$environment" "$cluster" "$task_arn")"

    # (q): the image never arrived, so the application never started. Launch again,
    # after a pause, while attempts remain; the last attempt falls through to the
    # verdict below, which reports the missing exit code and the stop reason.
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

    # The verdict first, but the log whatever the verdict: a task that failed is the one
    # whose output matters, and until 23 September 2026 a non-zero exit returned here
    # before the fetch below ever ran (run 35876269976 printed "exited 21" and nothing else).
    local verdict=0
    release_report_task "$step" "$described" "$container" "$expect_exit" || verdict=1
    release_print_task_logs "$environment" "$log_group" "$log_stream_prefix" "$container" "$task_arn" "$capture"
    # Read, so retired: the next invocation of this step launches its own task.
    release_retire_task_record "$record" "read_verdict_$verdict"
    return "$verdict"
  done
}

# The JSON object a command printed on stdout, out of the captured log lines.
#
#   release_captured_report <captured file> <destination>
#
# A one-off task's filesystem goes away with the task, so a `--report` file written
# inside it cannot be read afterwards. What survives is the log stream, and the tool's
# contract is one JSON object on stdout per command with every log line on stderr — so
# the answer is the last parseable JSON object in the capture. Refusing when there is
# none is the point: a drill whose report could not be read is a drill that did not
# report, not one that passed.
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
    # The tool logs JSON to stderr too, and awslogs interleaves both streams. A log
    # line always carries `level` and `event`; the answer never does.
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
  return 0
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

# (l), (m): every essential container's exit code, and the stop reason either way.
#
# A stopped task can carry no `exitCode` at all — an image that could not be pulled, a
# secret that could not be resolved, a task killed for capacity. `exitCode or 0` is the
# bug that turns each of those into a green release, so absence is a failure with its
# own message.
#
# The fourth argument is the code this step calls success (see `--expect-exit` above);
# it defaults to 0, and a step expecting a refusal fails on a zero exactly as an
# ordinary step fails on a non-zero. Absence of an exit code is a failure either way:
# "the container refused" and "the container never ran" must not be the same outcome.
release_report_task() {
  local step=$1 described=$2 container=$3 expected=${4:-0}
  if [ -z "$described" ]; then
    rehearsal_log "$step: no task description available (dry run)"
    return 0
  fi

  local verdict
  verdict="$(FSS_JSON="$described" FSS_CONTAINER="$container" python3 -c '
import json, os, sys

document = json.loads(os.environ["FSS_JSON"])
tasks = document.get("tasks") or []
if not tasks:
    print("no_task|the task disappeared between launch and description")
    raise SystemExit(0)

task = tasks[0]
stop_code = task.get("stopCode") or "<none>"
stopped_reason = task.get("stoppedReason") or "<none>"
print("info|stopCode={} stoppedReason={}".format(stop_code, stopped_reason))

containers = task.get("containers") or []
if not containers:
    print("no_containers|the task stopped with no container at all: {}".format(stopped_reason))
    raise SystemExit(0)

# Every essential container, not just the one the caller named: a sidecar that
# exits non-zero stops the task, and reading only the named container would call
# that a pass. The task definition is the authority on which are essential; in its
# absence the named container is treated as essential and the rest are reported.
worst = 0
for entry in containers:
    name = entry.get("name")
    code = entry.get("exitCode")
    reason = entry.get("reason") or ""
    if code is None:
        print("missing_exit_code|container {} stopped with no exit code. {} {}".format(name, stopped_reason, reason))
        raise SystemExit(0)
    print("info|container {} exited {} {}".format(name, code, reason).rstrip())
    if int(code) != 0:
        worst = int(code)
print("exit|{}".format(worst))
')"

  local line kind detail failed=0
  while IFS= read -r line; do
    kind=${line%%|*}
    detail=${line#*|}
    case "$kind" in
      info) rehearsal_log "$step: $detail" ;;
      exit)
        if [ "$detail" = "$expected" ]; then
          if [ "$expected" != "0" ]; then
            rehearsal_log "$step: exited $detail, which is the code this step requires"
          fi
        elif [ "$expected" = "0" ]; then
          echo "FAIL: $step exited $detail" >&2
          failed=1
        else
          echo "FAIL: $step exited $detail and this step requires exit $expected" >&2
          failed=1
        fi
        ;;
      *)
        echo "FAIL: $step — $detail" >&2
        failed=1
        ;;
    esac
  done <<<"$verdict"
  return "$failed"
}

# (n): the log stream, with a grace period for the create race.
#
# A task that stops in four seconds can be described before CloudWatch has created its
# stream, and `get-log-events` then answers `ResourceNotFoundException`. Treating that
# as "no output" throws away the one message that says what happened, so it is retried
# for a bounded time and then reported as an absence rather than swallowed.
release_print_task_logs() {
  local environment=$1 log_group=$2 stream_prefix=$3 container=$4 task_arn=$5 capture=${6:-}
  # Silence here has cost two rehearsal runs. Say why nothing is printed.
  if [ -z "$log_group" ] || [ -z "$stream_prefix" ]; then
    rehearsal_log "$container: no log group or stream prefix was given, so the task's own output is not shown" >&2
    return 0
  fi

  local task_id stream events waited=0
  task_id=${task_arn##*/}
  stream="${stream_prefix}/${container}/${task_id}"

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
      local status=$?
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
      # The stream exists but holds nothing yet: the driver is still delivering. Wait
      # for it the same way, rather than printing nothing and moving on.
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

  # Only the `message` field of each event. The tool writes JSON log lines and never
  # puts a value in one; printing the raw response would print whatever else
  # CloudWatch chose to include.
  #
  # `--capture` writes the same messages, unindented, to a file, because a one-off
  # task's filesystem goes away with the task and its log stream is the only thing
  # that survives. `release_captured_report` reads the command's JSON answer back out
  # of it.
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
