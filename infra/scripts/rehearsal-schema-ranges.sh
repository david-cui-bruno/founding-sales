#!/usr/bin/env bash
# Appendix G 22: "Old API with new worker and reverse across every expand/contract
# phase obey schema ranges."
#
#   infra/scripts/rehearsal-schema-ranges.sh <fss-rh-run> [--api-digest D] [--worker-digest D]
#
# The deploy order is migrate, then worker, then API (coordinator note, 20 September),
# and it belongs to `infra/scripts/release-deploy.sh`. What is left here is the part a
# unit test cannot answer: an image either starts or it does not, and `--selftest` is
# the cheapest way to ask it.
#
# ## Where the ranges do not overlap, the scenario is the refusal
#
# From migration 0006 onwards every declared range is strict `{N, N}` for both
# processes, so "the previous image against the new schema" has no compatible pair to
# demonstrate. That is not a gap in the test; it is what the ranges say. The scenario
# therefore asserts the *refusal* — `database_ahead_of_binary` when the schema has moved
# past the image's maximum, `database_behind_binary` when it has not reached the
# minimum — and says which it expected and why.
#
# A release whose ranges *do* overlap (an expand release that widens one side a release
# ahead of its migration) makes the overlap case run instead, and both are computed
# from `packages/domain/db/schemaRange.ts` rather than from a literal here, so this
# script does not have to be edited when a lane widens a range.
#
# ## What the seventh full run found, and what this step measures now (lane g38)
#
# On 23 September 2026 the rehearsal reached this step for the first time and it failed
# in a second, for two reasons that were both this script's:
#
#   1. **the overlap case named a task definition nothing creates.** With
#      `PREVIOUS_RELEASE_SCHEMA_RANGE = {1,15}` accepting schema 15, it ran
#      `ecs run-task --task-definition <prefix>-<service>-previous`. No root registers
#      a `-previous` family — `infra/modules/cluster` registers `-api`, `-worker`,
#      `-migration`, `-operations` and `-drill` — and on a first release there is no
#      previous image at all. The existence of that definition is therefore a *fact
#      this step reads* before it uses it: absent, the case is recorded as skipped and
#      the run continues; present, its `--selftest` must exit 0.
#
#   2. **the stale case measured the wrong thing.** It called `command aws ecs run-task`
#      — outside the wrapper — and treated a successful *API call* as "the image
#      accepted the range". The refusal happens inside the container at startup, not in
#      the API response; and a Fargate task definition (`awsvpc`) cannot be launched
#      without `--network-configuration`, so the call failed client-side every time and
#      the case passed vacuously. Every launch now goes through `release_run_task`,
#      which supplies the network plan from the root's own output, waits for the task
#      to stop, prints its log lines and reads the *container's* exit code.
#
# ## The exit code a refusal has
#
# `<prefix>-api` and `<prefix>-worker` run the two service images, whose entry points
# are `apps/api/src/bootstrap/main.ts` and `apps/worker/src/bootstrap/main.ts`. Both
# read their configuration first, both raise `SCHEMA_RANGE_DISAGREES`
# (`apps/*/src/bootstrap/config.ts`) when `FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX` are not the
# range the image was built with, and both return `configurationInvalid`, which is
# **12** in `API_EXIT_CODES` and in `WORKER_EXIT_CODES`. One code, documented in two
# places, asserted in one below.
#
# It is *not* the `fss` tool's 20 (`FSS_EXIT_CODES.refused`, `apps/worker/src/tools/fss.ts`).
# That tool is the entry point of the migration, operations and drill definitions, and
# it deliberately does not read `FSS_SCHEMA_MIN`/`FSS_SCHEMA_MAX` at all — so it can
# neither give nor withhold this refusal, and a step that expected 20 here would be
# expecting a code this task cannot produce.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"
# `release-common.sh` sources `rehearsal-common.sh` itself, for the production-name
# refusal, the dry-run mode and the reports directory. Sourcing both here would run
# `set -euo pipefail` and redeclare every constant twice for no gain.

PREFIX=${1:-}
shift 1 2>/dev/null || true

# The digests this release is about. The wrapper refuses to launch a task whose
# registered image is anything else, and that refusal is the release gate at the moment
# of use — a step that launched last release's image would prove nothing about this
# one. Arguments win; the environment is how `rehearsal-restore-drill.sh` passes them
# on, the same way it already passes `FSS_RELEASE_WORKER_DIGEST` to `rehearsal-run-task.sh`.
API_DIGEST=${FSS_RELEASE_API_DIGEST:-}
WORKER_DIGEST=${FSS_RELEASE_WORKER_DIGEST:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-digest) API_DIGEST=$2; shift 2 ;;
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    *) echo "FAIL: rehearsal-schema-ranges.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

rehearsal_require_prefix "$PREFIX"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TERRAFORM_ROOT="${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}"

# The exit code both service images give a declared range they do not accept. See the
# header: one code, from `API_EXIT_CODES.configurationInvalid` and
# `WORKER_EXIT_CODES.configurationInvalid`.
SCHEMA_REFUSAL_EXIT_CODE=12

read_range() { # read_range <exported constant>
  node --experimental-transform-types --disable-warning=ExperimentalWarning \
    --input-type=module -e "
      const module = await import('$ROOT/packages/domain/db/schemaRange.ts');
      const range = module['$1'];
      process.stdout.write(String(range.minimum) + ' ' + String(range.maximum));
    "
}

read api_min api_max <<<"$(read_range API_SCHEMA_RANGE)"
read worker_min worker_max <<<"$(read_range WORKER_SCHEMA_RANGE)"
read previous_min previous_max <<<"$(read_range PREVIOUS_RELEASE_SCHEMA_RANGE)"
# CURRENT_SCHEMA_VERSION is a number rather than a range, so it is read on its own.
current="$(node --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module -e "
  const module = await import('$ROOT/packages/domain/db/schemaRange.ts');
  process.stdout.write(String(module.CURRENT_SCHEMA_VERSION));
")"

rehearsal_log "api {$api_min,$api_max} worker {$worker_min,$worker_max} previous {$previous_min,$previous_max} schema $current"

# ---------------------------------------------------------------------------
# The declared order is not this script's any more (G12h).
#
# It used to do the deployment: two `update-service --force-new-deployment` calls and
# two waits, under a heading that said "migrate, then worker, then API" while nothing
# anywhere ran a migration. That was the gap David's decision of 21 September closed.
# The order now lives in `infra/scripts/release-deploy.sh`, which is the one code path
# for the rehearsal and for production, and which actually migrates — as a one-off
# ECS task inside the VPC, because the database is private.
# ---------------------------------------------------------------------------
rehearsal_log "deploy order (migrate, worker, API) belongs to release-deploy.sh; this is Appendix G 22's refusal half"

# ---------------------------------------------------------------------------
# Everything a launch needs, from the same places `release-deploy.sh` reads it: the
# root's own outputs and the identity of the credentials in this shell. Nothing below
# is a literal a person has to keep in step with a plan.
#
# In a dry run each of these prints the command it would have run and returns nothing;
# no case below launches anything in that mode, so the empties are never used.
# ---------------------------------------------------------------------------
CLUSTER_ARN="$(release_output "$TERRAFORM_ROOT" cluster_arn)"
NETWORK_PLAN="$(release_output "$TERRAFORM_ROOT" task_network_configuration json)"
RUNTIME_SECRET_ARN="$(release_output "$TERRAFORM_ROOT" app_runtime_database_secret_arn)"
DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"
ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
REGION="${AWS_REGION:-us-east-1}"

if ! rehearsal_dry_run; then
  if [ -z "$API_DIGEST" ] || [ -z "$WORKER_DIGEST" ]; then
    echo "FAIL: both --api-digest and --worker-digest are required (or FSS_RELEASE_API_DIGEST and FSS_RELEASE_WORKER_DIGEST)." >&2
    echo "      This step launches the API and the worker task definitions, and the wrapper refuses" >&2
    echo "      to launch a task whose registered image is not the digest this release is about. It" >&2
    echo "      cannot compare against a digest it was not given." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Reading a task definition, including the answer "nothing registers one".
# ---------------------------------------------------------------------------

# The registered definition of a family as JSON, or nothing at all when the family is
# unregistered. Absence is a fact this script acts on; every other failure is a failure.
#
#   task_definition_json <family>
#
# ECS answers an unregistered family with `(ClientException) … Unable to describe task
# definition`, and `ClientException` alone is far too broad to treat as absence — it is
# also what a malformed request gets. Both halves are required, so an `AccessDenied`, a
# throttle or a timeout still stops the run rather than being read as "there is no
# previous image".
task_definition_json() {
  local family=$1 output status
  set +e
  output="$(rehearsal_aws ecs describe-task-definition --task-definition "$family" \
    --query 'taskDefinition' --output json 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf '%s' "$output"
    return 0
  fi
  case "$output" in
    *"(ClientException)"*"Unable to describe task definition"*) return 0 ;;
  esac
  printf '%s\n' "$output" >&2
  echo "FAIL: $family could not be described, and not because it is unregistered." >&2
  return 1
}

# One container of a registered definition, as JSON.
definition_container() { # definition_container <definition json> <container name>
  FSS_JSON="$1" FSS_NAME="$2" python3 -c '
import json, os, sys
for entry in json.loads(os.environ["FSS_JSON"] or "{}").get("containerDefinitions") or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        json.dump(entry, sys.stdout)
        break
'
}

# ---------------------------------------------------------------------------
# One `--selftest`, inside the VPC, through the one wrapper.
#
#   launch_selftest <step> <container> <definition json> <image digest> <expected exit>
#                   [--env NAME=VALUE]...
#
# `release_run_task` is what `release-deploy.sh` already launches every one-off task
# with: it checks the cluster's environment tag, the ARNs, the registered image against
# the digest this release names and the network against the root's own plan; it
# launches with the network configuration an `awsvpc` task cannot start without; it
# waits for the task to stop, prints the task's log lines, and judges the *container's*
# exit code — which is the only place a startup refusal is visible.
#
# The log group and the stream prefix are read from the definition being launched
# rather than from a root output, because they are a property of that definition: the
# API writes to the API group and the worker to the worker group, and a `-previous`
# definition writes wherever it was registered to write.
# ---------------------------------------------------------------------------
launch_selftest() {
  local step=$1 container_name=$2 definition=$3 digest=$4 expect=$5
  shift 5

  local container arn log_group stream_prefix
  container="$(definition_container "$definition" "$container_name")"
  if [ -z "$container" ]; then
    echo "FAIL: the task definition for $step has no container named '$container_name'" >&2
    return 1
  fi
  arn="$(release_json_path "$definition" "taskDefinitionArn")"
  log_group="$(release_json_path "$container" "logConfiguration.options.awslogs-group")"
  stream_prefix="$(release_json_path "$container" "logConfiguration.options.awslogs-stream-prefix")"

  release_run_task \
    --step "$step" \
    --environment rehearsal \
    --prefix "$PREFIX" \
    --account "$ACCOUNT" \
    --region "$REGION" \
    --cluster "$CLUSTER_ARN" \
    --task-definition "$arn" \
    --container "$container_name" \
    --network-plan "$NETWORK_PLAN" \
    --image-digest "$digest" \
    --database-host "$DATABASE_HOST" \
    --secret-arn "$RUNTIME_SECRET_ARN" \
    --log-group "$log_group" \
    --log-stream-prefix "$stream_prefix" \
    --expect-exit "$expect" \
    "$@" \
    -- --selftest
}

# ---------------------------------------------------------------------------
# The two reverse cases. Each sets CASE_VERDICT, which the report records: a verdict
# returned on stdout would be mixed with the log lines the case prints.
# ---------------------------------------------------------------------------
CASE_VERDICT=''

refusal_for() { # refusal_for <binary minimum> <binary maximum> <schema version>
  local minimum=$1 maximum=$2 version=$3
  if [ "$version" -lt "$minimum" ]; then echo database_behind_binary
  elif [ "$version" -gt "$maximum" ]; then echo database_ahead_of_binary
  else echo accepted
  fi
}

# The overlap case: the previous release's range accepts the current schema, so the
# previous image really can run against it — if one is registered.
overlap_case() { # overlap_case <service>
  # Two `local`s: a word of one `local` is expanded before any of its assignments takes
  # effect, so `${service}` here would be the caller's variable, not this `$1` (SC2318).
  local service=$1
  local family="${PREFIX}-${service}-previous" definition image digest
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecs describe-task-definition --task-definition $family --query taskDefinition"
    rehearsal_plan "if it is registered: launch $family --selftest through release_run_task and require the container to exit 0"
    rehearsal_plan "if it is not: record ${service}_overlap=skipped_no_previous and continue, because a first release has no previous image"
    CASE_VERDICT=planned
    return 0
  fi

  definition="$(task_definition_json "$family")" || return 1
  if [ -z "$definition" ]; then
    # The first release, and every release after one whose predecessor was never
    # registered under this name: there is no previous image to start. Saying so is
    # the honest answer; failing would fail the rehearsal for a fact about history.
    rehearsal_log "$service: nothing registers $family, so no previous image exists to run and the overlap case has nothing to launch (first release)"
    CASE_VERDICT=skipped_no_previous
    return 0
  fi

  # The previous image is by definition not this release's digest, so the digest the
  # wrapper compares against is the one that definition itself registers. The check
  # that carries this case is the exit code, not the digest.
  image="$(release_json_path "$(definition_container "$definition" "$service")" "image")"
  case "$image" in
    *@sha256:*) digest="sha256:${image##*@sha256:}" ;;
    *)
      echo "FAIL: $family registers '$image', which is a tag rather than a digest, and a tag cannot carry the comparison the wrapper makes." >&2
      return 1
      ;;
  esac

  rehearsal_log "$service: $family is registered at $digest; its --selftest must accept schema $current"
  if ! launch_selftest "schema-overlap-$service" "$service" "$definition" "$digest" 0; then
    echo "FAIL: $family did not start against schema $current, which its declared range {$previous_min,$previous_max} accepts." >&2
    return 1
  fi
  CASE_VERDICT="ran_exit_0"
  return 0
}

# The forward case that must always refuse: a task definition declaring a range one
# below the image's minimum is a stale deployment, whatever the numbers become.
stale_case() { # stale_case <service> <stale version> <image digest>
  local service=$1 stale=$2 digest=$3
  local family="${PREFIX}-${service}" definition
  rehearsal_log "$service: a task definition declaring {$stale,$stale} must be refused at startup"
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecs describe-task-definition --task-definition $family --query taskDefinition"
    rehearsal_plan "launch $family --selftest through release_run_task with FSS_SCHEMA_MIN=$stale FSS_SCHEMA_MAX=$stale and require the container to exit $SCHEMA_REFUSAL_EXIT_CODE"
    CASE_VERDICT=planned
    return 0
  fi

  definition="$(task_definition_json "$family")" || return 1
  if [ -z "$definition" ]; then
    echo "FAIL: nothing registers $family, so there is no image here to refuse anything." >&2
    echo "      The apply registers it and release-deploy.sh deploys it; a run that reached this" >&2
    echo "      step without one has not deployed what this step is about." >&2
    return 1
  fi

  if ! launch_selftest "schema-stale-$service" "$service" "$definition" "$digest" "$SCHEMA_REFUSAL_EXIT_CODE" \
      --env "FSS_SCHEMA_MIN=$stale" --env "FSS_SCHEMA_MAX=$stale"; then
    echo "FAIL: $family did not refuse the declared range {$stale,$stale} at startup." >&2
    echo "      The wrapper's line above says what the container did: exit 0 is the image accepting" >&2
    echo "      a range it does not support, and any other code is a stop for some other reason —" >&2
    echo "      neither is the refusal this case measures (expected exit $SCHEMA_REFUSAL_EXIT_CODE)." >&2
    return 1
  fi
  rehearsal_log "$service: refused {$stale,$stale} at startup with exit $SCHEMA_REFUSAL_EXIT_CODE, which is this case's assertion"
  CASE_VERDICT="refused_exit_$SCHEMA_REFUSAL_EXIT_CODE"
  return 0
}

overlaps=0
verdicts=''
for pair in "api:$api_min:$API_DIGEST" "worker:$worker_min:$WORKER_DIGEST"; do
  # The digest is last, so the colons inside `sha256:…` stay in it.
  IFS=: read -r service minimum digest <<<"$pair"

  previous_verdict="$(refusal_for "$previous_min" "$previous_max" "$current")"
  if [ "$previous_verdict" = accepted ]; then
    overlaps=$((overlaps + 1))
    rehearsal_log "$service: the previous release's range {$previous_min,$previous_max} accepts schema $current, so the overlap case runs"
    overlap_case "$service"
  else
    rehearsal_log "$service: no overlap. The previous image refuses schema $current with $previous_verdict, which is the assertion."
    CASE_VERDICT="$previous_verdict"
  fi
  verdicts="$verdicts ${service}_overlap=$CASE_VERDICT"

  stale_case "$service" "$((minimum - 1))" "$digest"
  verdicts="$verdicts ${service}_stale=$CASE_VERDICT"
done

rehearsal_write_report "schema-ranges.txt" \
  "api={$api_min,$api_max} worker={$worker_min,$worker_max} previous={$previous_min,$previous_max} schema=$current overlapping_pairs=$overlaps${verdicts}"
rehearsal_log "Appendix G 22 complete: $overlaps overlapping pair(s), the rest asserted as refusals"
