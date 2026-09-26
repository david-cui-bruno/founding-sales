#!/usr/bin/env bash
# The schema rehearsal's scripts in one (P7, 27 September 2026). The rehearsal is
# .github/workflows/greenfield-release.yml, dispatch only, mode=schema; full mode and the
# restore drill were deleted with W3-S8. docs/greenfield/release.md 3 is the operator's page.
#
#   rehearsal.sh prefix   <fss-rh-run>                      the run prefix, judged before anything exists
#   rehearsal.sh identity [fss-rh-deploy]                   this session is an assumed-role session of the role
#   rehearsal.sh run-task <fss-rh-run> <step> <migration|operations> -- <fss command word>...
#   rehearsal.sh ranges   <fss-rh-run> [--api-digest D] [--worker-digest D]
#   rehearsal.sh teardown <fss-rh-run>                      everything the run made, the locked journal included
#   rehearsal.sh guard    <fss-rh-run>                      after the teardown: nothing left, nothing production's
#   rehearsal.sh leftovers <fss-rh-run>                     what still carries the run prefix, one line each
#
# It replaces rehearsal-caller-identity.sh (identity), rehearsal-run-task.sh (run-task),
# rehearsal-schema-ranges.sh (ranges), rehearsal-teardown.sh (teardown) and
# rehearsal-prefix-guard.sh (`before` is prefix, `after` is guard), which exec it.
#
# Appendix G 39 is why most of this exists: "production and rehearsal Terraform plans use
# distinct state keys, roles, secrets and resource namespaces; rehearsal teardown cannot
# address production resources." Every AWS call goes through lib.sh's rehearsal_aws, which
# refuses an argument naming `fss-prod`; every Terraform call runs with
# `-var=assume_deployment_role=false`, which is safe only in a session of `fss-rh-deploy`,
# so `identity` proves that before the create and `teardown` proves it again itself.
#
# No dry run (P7: only the deploy path keeps one). test/ops/scenario39.check.ts and
# scenario22.check.ts drive every subcommand against stub CLIs. Offline seams:
# FSS_REHEARSAL_AWS_COMMAND, TERRAFORM, FSS_REHEARSAL_CALLER_IDENTITY, FSS_REHEARSAL_REPORTS,
# FSS_REHEARSAL_JOURNAL_BUCKET, FSS_REHEARSAL_ROOT, FSS_REHEARSAL_STATE_BUCKET,
# FSS_REHEARSAL_STATE_KEY, FSS_REHEARSAL_LOCK_TABLE, FSS_REHEARSAL_SETTLING_READS,
# FSS_REHEARSAL_SETTLING_SECONDS and lib.sh's FSS_RELEASE_* fixtures.

REHEARSAL_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$REHEARSAL_SCRIPTS/lib.sh"

rehearsal_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

rehearsal_usage() {
  cat >&2 <<'USAGE'
usage: rehearsal.sh prefix   <fss-rh-run>
       rehearsal.sh identity [fss-rh-deploy]
       rehearsal.sh run-task <fss-rh-run> <step> <migration|operations> -- <fss command word>...
       rehearsal.sh ranges   <fss-rh-run> [--api-digest D] [--worker-digest D]
       rehearsal.sh teardown <fss-rh-run>
       rehearsal.sh guard    <fss-rh-run>
       rehearsal.sh leftovers <fss-rh-run>
USAGE
  exit 2
}

# The two rehearsal repositories that carry no run identifier (infra/roots/rehearsal-registry).
REHEARSAL_STABLE_NAMES='fss-rh-api fss-rh-worker'
REHEARSAL_NO_ASSUME_VAR='-var=assume_deployment_role=false'
REHEARSAL_SESSION_ACCOUNT=''

# `rehearsal-run`, `rehearsal-stable`, `production` or `foreign`; non-zero for anything a
# rehearsal may not address.   rehearsal_classify_name <run prefix> <name>
rehearsal_classify_name() {
  local prefix=$1 name=$2 stable
  case "$name" in "$PRODUCTION_PREFIX"*) echo production; return 1 ;; esac
  for stable in $REHEARSAL_STABLE_NAMES; do
    if [ "$name" = "$stable" ]; then echo rehearsal-stable; return 0; fi
  done
  case "$name" in "$prefix"*) echo rehearsal-run; return 0 ;; esac
  echo foreign
  return 1
}

# A cleanup step that finds nothing to clean is done. Absence is the AWS error code in
# parentheses; an AccessDenied or a throttle is still a failure, because "it is gone" and
# "I was not allowed to look" must not report the same thing.
#   rehearsal_tolerate_absent <what> <command> [argument...]
REHEARSAL_ABSENCE_ERROR_CODES='DBInstanceNotFound DBInstanceNotFoundFault NoSuchBucket ResourceNotFoundException ClusterNotFoundException ServiceNotFoundException NoSuchEntity'
rehearsal_tolerate_absent() {
  local what=$1 output status code
  shift
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    if [ -n "$output" ]; then printf '%s\n' "$output"; fi
    return 0
  fi
  for code in $REHEARSAL_ABSENCE_ERROR_CODES; do
    case "$output" in
      *"($code)"*) rehearsal_log "$what: already absent ($code), so this step is done" >&2; return 0 ;;
    esac
  done
  printf '%s\n' "$output" >&2
  echo "FAIL: $what did not fail because the resource was absent; it failed for another reason" >&2
  return 1
}

# The session is an assumed-role session of <role>, in the fss-rh- namespace (G12e). A
# user, another role, a role whose name merely begins the same way, or no identity at all
# is refused. Sets REHEARSAL_SESSION_ACCOUNT.   rehearsal_require_deployment_session <role>
rehearsal_require_deployment_session() {
  local role=${1:-} identity pattern
  case "$role" in
    fss-rh-*) ;;
    *) rehearsal_fail "'${role:-<none>}' is not a rehearsal deployment role; this check is for the fss-rh- namespace. A production apply assumes its role in the provider and never runs with ${REHEARSAL_NO_ASSUME_VAR}." ;;
  esac
  if [ "${FSS_REHEARSAL_CALLER_IDENTITY+set}" = "set" ]; then
    identity=$FSS_REHEARSAL_CALLER_IDENTITY
  else
    identity="$(command "$(rehearsal_aws_command)" sts get-caller-identity --query Arn --output text)" || identity=''
  fi
  echo "caller identity: ${identity:-<none>}"
  pattern="^arn:aws[a-z0-9-]*:sts::[0-9]{12}:assumed-role/${role}/.+$"
  if [[ ! "$identity" =~ $pattern ]]; then
    echo "FAIL: this session is ${identity:-<none>}, which is not an assumed-role session of $role." >&2
    echo "      Rehearsal Terraform runs with ${REHEARSAL_NO_ASSUME_VAR}, so whatever this session is" >&2
    echo "      is what the apply would act as. Refusing." >&2
    exit 1
  fi
  REHEARSAL_SESSION_ACCOUNT="${identity#arn:*:sts::}"
  REHEARSAL_SESSION_ACCOUNT="${REHEARSAL_SESSION_ACCOUNT%%:*}"
  rehearsal_log "the session is an assumed-role session of $role, so ${REHEARSAL_NO_ASSUME_VAR} is safe"
}

# `terraform state list` in the working directory: prints the addresses and returns 0, or
# returns 3 for a root that was never initialised (the create step never ran), which is
# what a run that created nothing looks like. Any other failure exits 1.
#   state="$(rehearsal_state_list)"; status=$?   (under set +e)
rehearsal_state_list() {
  local state status
  set +e
  state="$(command "${TERRAFORM:-terraform}" state list 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf '%s' "$state" | sed '/^[[:space:]]*$/d'
    return 0
  fi
  case "$state" in
    *"Backend initialization required"* | *"Initialization required"* | *"No state file was found"* | *"Missing backend configuration"*)
      rehearsal_log "the rehearsal root was never initialised, so this run created nothing:" >&2
      printf '%s\n' "$state" | head -3 | sed 's/^/  /' >&2
      return 3
      ;;
  esac
  printf '%s\n' "$state" >&2
  rehearsal_fail "the rehearsal state could not be read, and not because the run created nothing"
}

# ---------------------------------------------------------------------------
# prefix: the workflow's first step, before any credential.
# ---------------------------------------------------------------------------
rehearsal_prefix() {
  rehearsal_require_prefix "${1:-}" || exit 1
  rehearsal_log "run prefix ${1}: a rehearsal prefix, and nothing production's"
}

# ---------------------------------------------------------------------------
# identity: before the create, and again after the session is renewed for the teardown.
# ---------------------------------------------------------------------------
rehearsal_identity() {
  local role=${1:-fss-rh-deploy}
  rehearsal_refuse_production_arguments "$role" || exit 1
  rehearsal_require_deployment_session "$role"
  rehearsal_write_report "caller-identity.txt" "role=$role assumed_role_session=true"
}

# ---------------------------------------------------------------------------
# run-task: one `fss` command inside the rehearsal VPC, as a one-off ECS task (lane G12h).
# The engine is lib.sh's release_run_task, which the production path uses unchanged; this
# resolves the run's definitions, cluster and network from infra/roots/rehearsal's outputs.
# The database is private and a GitHub runner cannot reach it.
# ---------------------------------------------------------------------------
rehearsal_run_task() {
  local prefix=${1:-} step=${2:-} kind=${3:-} root definition secret cluster network log_group host
  shift 3 2>/dev/null || true
  if [ "${1:-}" = "--" ]; then shift; fi
  rehearsal_require_prefix "$prefix" || exit 1
  [ -n "$step" ] || rehearsal_fail "every one-off task needs a step name. The name is what the recorded task ARN is filed under, and an unnamed step is a step a retry cannot recognise."
  case "$kind" in
    migration | operations) ;;
    *) rehearsal_fail "'${kind:-<empty>}' is not a task definition this rehearsal has: 'migration' is the DDL identity, 'operations' the runtime identity that runs fss verify (docs/archive/decisions/g12h-three-one-off-identities.md; the third, the drill's, went with W3-S8)" ;;
  esac
  [ "$#" -gt 0 ] || rehearsal_fail "rehearsal.sh run-task needs a command after --"
  # The digest is the release gate at the moment of use: a task given no digest cannot be
  # told apart from one running last release's image.
  [ -n "${FSS_RELEASE_WORKER_DIGEST:-}" ] \
    || rehearsal_fail "FSS_RELEASE_WORKER_DIGEST is not set. The wrapper compares the registered task definition's image against the digest this release is about, and it will not launch without one."

  root="${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}"
  cluster="$(release_output "$root" cluster_arn)"
  network="$(release_output "$root" task_network_configuration json)"
  log_group="$(release_output "$root" worker_log_group_name)"
  host="$(release_json_path "${network:-}" database_host)"
  # The migration task carries no runtime connection (the tool never falls back to one for
  # `migrate`), so there is no DATABASE_SECRET_ARN reference to hold it to.
  definition="$(release_output "$root" "${kind}_task_definition_arn")"
  secret=''
  if [ "$kind" = operations ]; then secret="$(release_output "$root" app_runtime_database_secret_arn)"; fi

  # A one-off task's filesystem goes with it, so a `--report` written inside it is read
  # back out of the log stream (FSS_RELEASE_CAPTURE, then release_captured_report).
  local -a extra=()
  if [ -n "${FSS_RELEASE_CAPTURE:-}" ]; then extra+=(--capture "$FSS_RELEASE_CAPTURE"); fi
  release_run_task ${extra[@]+"${extra[@]}"} --step "$step" --environment rehearsal --prefix "$prefix" \
    --account "${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}" --region "${AWS_REGION:-us-east-1}" \
    --cluster "$cluster" --task-definition "$definition" --container "$kind" --network-plan "$network" \
    --image-digest "$FSS_RELEASE_WORKER_DIGEST" --database-host "$host" --secret-arn "$secret" \
    --log-group "$log_group" --log-stream-prefix "$kind" -- "$@"
}

# ---------------------------------------------------------------------------
# ranges: Appendix G 22's refusal half, "old API with new worker and reverse across every
# expand/contract phase obey schema ranges". The deploy order (migrate, worker, API) is
# deploy.sh release's; what is left is what a unit test cannot answer: an image either
# starts or it does not, and `--selftest` is the cheapest way to ask it.
#
# From migration 0006 every declared range is a strict {N,N} for both processes, so "the
# previous image against the new schema" has no compatible pair to show. The scenario is
# then the refusal, computed from packages/domain/db/schemaRange.ts rather than a literal:
#   * overlap: when the previous release's range accepts the current schema, the previous
#     image must start against it — if `<prefix>-<service>-previous` is registered. On a
#     first release nothing registers it, and the case is recorded as skipped (lane g38:
#     the seventh full run launched a family nothing creates);
#   * stale: a task definition declaring a range one below the image's minimum must be
#     refused at startup, with exit 12 (`configurationInvalid` in API_EXIT_CODES and
#     WORKER_EXIT_CODES, raised as SCHEMA_RANGE_DISAGREES by apps/*/src/bootstrap/config.ts).
#     Not the fss tool's 20: the migration and operations entry point never reads
#     FSS_SCHEMA_MIN/MAX.
# Every launch goes through release_run_task, which supplies the network plan, waits for the
# task to stop, prints its log lines and judges the container's exit code, which is the only
# place a startup refusal shows (lane g38: an `aws ecs run-task` read as the answer passed
# vacuously).
# ---------------------------------------------------------------------------
SCHEMA_REFUSAL_EXIT_CODE=12

rehearsal_ranges() {
  local prefix=${1:-}
  shift 1 2>/dev/null || true
  # Arguments win; FSS_RELEASE_API_DIGEST and FSS_RELEASE_WORKER_DIGEST are the same two
  # values from the environment. The wrapper refuses a task whose registered image is not
  # this release's digest, which is the release gate at the moment of use.
  RANGES_API_DIGEST=${FSS_RELEASE_API_DIGEST:-}
  RANGES_WORKER_DIGEST=${FSS_RELEASE_WORKER_DIGEST:-}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --api-digest) RANGES_API_DIGEST=${2:-}; shift 2 ;;
      --worker-digest) RANGES_WORKER_DIGEST=${2:-}; shift 2 ;;
      *) rehearsal_fail "rehearsal.sh ranges does not take '$1'" ;;
    esac
  done
  rehearsal_require_prefix "$prefix" || exit 1
  RANGES_PREFIX=$prefix
  if [ -z "$RANGES_API_DIGEST" ] || [ -z "$RANGES_WORKER_DIGEST" ]; then
    rehearsal_fail "both --api-digest and --worker-digest are required (or FSS_RELEASE_API_DIGEST and FSS_RELEASE_WORKER_DIGEST): this step launches the API and worker task definitions, and the wrapper cannot compare a registered image against a digest it was not given"
  fi

  local repository range_values api_min api_max worker_min worker_max previous_min previous_max current root
  repository="$(cd "$REHEARSAL_SCRIPTS/../.." && pwd)"
  range_values="$(FSS_SCHEMA_RANGE_FILE="$repository/packages/domain/db/schemaRange.ts" node --experimental-transform-types \
    --disable-warning=ExperimentalWarning --input-type=module -e "
      const { pathToFileURL } = await import('node:url');
      const m = await import(pathToFileURL(process.env.FSS_SCHEMA_RANGE_FILE).href);
      const pairs = [m.API_SCHEMA_RANGE, m.WORKER_SCHEMA_RANGE, m.PREVIOUS_RELEASE_SCHEMA_RANGE];
      process.stdout.write([...pairs.flatMap(r => [r.minimum, r.maximum]), m.CURRENT_SCHEMA_VERSION].join(' '));
    ")" || rehearsal_fail "the schema ranges could not be read from packages/domain/db/schemaRange.ts"
  read -r api_min api_max worker_min worker_max previous_min previous_max current <<<"$range_values"
  RANGES_CURRENT=$current
  RANGES_PREVIOUS="{$previous_min,$previous_max}"
  rehearsal_log "api {$api_min,$api_max} worker {$worker_min,$worker_max} previous {$previous_min,$previous_max} schema $current"

  root="${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}"
  RANGES_CLUSTER="$(release_output "$root" cluster_arn)"
  RANGES_NETWORK="$(release_output "$root" task_network_configuration json)"
  RANGES_SECRET="$(release_output "$root" app_runtime_database_secret_arn)"
  RANGES_HOST="$(release_json_path "${RANGES_NETWORK:-}" database_host)"
  RANGES_ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"

  local overlaps=0 verdicts='' service minimum digest previous_verdict
  for service in api worker; do
    minimum=$api_min digest=$RANGES_API_DIGEST
    if [ "$service" = worker ]; then minimum=$worker_min digest=$RANGES_WORKER_DIGEST; fi
    if [ "$current" -lt "$previous_min" ]; then previous_verdict=database_behind_binary
    elif [ "$current" -gt "$previous_max" ]; then previous_verdict=database_ahead_of_binary
    else previous_verdict=accepted
    fi
    if [ "$previous_verdict" = accepted ]; then
      overlaps=$((overlaps + 1))
      rehearsal_log "$service: the previous release's range {$previous_min,$previous_max} accepts schema $current, so the overlap case runs"
      ranges_overlap "$service"
    else
      rehearsal_log "$service: no overlap. The previous image refuses schema $current with $previous_verdict, which is the assertion."
      RANGES_VERDICT=$previous_verdict
    fi
    verdicts="$verdicts ${service}_overlap=$RANGES_VERDICT"
    ranges_stale "$service" "$((minimum - 1))" "$digest"
    verdicts="$verdicts ${service}_stale=$RANGES_VERDICT"
  done
  rehearsal_write_report "schema-ranges.txt" \
    "api={$api_min,$api_max} worker={$worker_min,$worker_max} previous={$previous_min,$previous_max} schema=$current overlapping_pairs=$overlaps${verdicts}"
  rehearsal_log "Appendix G 22 complete: $overlaps overlapping pair(s), the rest asserted as refusals"
}

# The registered definition of a family as JSON, or nothing when nothing registers it.
# ECS answers an unregistered family `(ClientException) … Unable to describe task
# definition`; both halves are required, because ClientException alone is also what a
# malformed request gets, and an AccessDenied must stop the run rather than read as "there
# is no previous image".
ranges_definition() {
  local family=$1 output status
  set +e
  output="$(rehearsal_aws ecs describe-task-definition --task-definition "$family" --query 'taskDefinition' --output json 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then printf '%s' "$output"; return 0; fi
  case "$output" in *"(ClientException)"*"Unable to describe task definition"*) return 0 ;; esac
  printf '%s\n' "$output" >&2
  echo "FAIL: $family could not be described, and not because it is unregistered." >&2
  return 1
}

# One --selftest through release_run_task. The log group and stream prefix come from the
# definition being launched, because they are a property of that definition.
#   ranges_selftest <step> <container> <definition json> <digest> <expected exit> [--env NAME=VALUE]...
ranges_selftest() {
  local step=$1 name=$2 definition=$3 digest=$4 expect=$5 container
  shift 5
  container="$(FSS_JSON="$definition" FSS_NAME="$name" python3 -c '
import json, os, sys
for entry in json.loads(os.environ["FSS_JSON"] or "{}").get("containerDefinitions") or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        json.dump(entry, sys.stdout)
        break
')"
  [ -n "$container" ] || { echo "FAIL: the task definition for $step has no container named '$name'" >&2; return 1; }
  release_run_task --step "$step" --environment rehearsal --prefix "$RANGES_PREFIX" --account "$RANGES_ACCOUNT" \
    --region "${AWS_REGION:-us-east-1}" --cluster "$RANGES_CLUSTER" --task-definition "$(release_json_path "$definition" taskDefinitionArn)" \
    --container "$name" --network-plan "$RANGES_NETWORK" --image-digest "$digest" --database-host "$RANGES_HOST" \
    --secret-arn "$RANGES_SECRET" --log-group "$(release_json_path "$container" logConfiguration.options.awslogs-group)" \
    --log-stream-prefix "$(release_json_path "$container" logConfiguration.options.awslogs-stream-prefix)" \
    --expect-exit "$expect" "$@" -- --selftest
}

ranges_overlap() {
  local service=$1
  local family="${RANGES_PREFIX}-${service}-previous" definition image digest
  definition="$(ranges_definition "$family")" || exit 1
  if [ -z "$definition" ]; then
    rehearsal_log "$service: nothing registers $family, so no previous image exists to run and the overlap case has nothing to launch (first release)"
    RANGES_VERDICT=skipped_no_previous
    return 0
  fi
  # The previous image is by definition not this release's digest, so the digest the
  # wrapper compares against is the one that definition registers.
  image="$(FSS_JSON="$definition" FSS_NAME="$service" python3 -c '
import json, os
for entry in json.loads(os.environ["FSS_JSON"] or "{}").get("containerDefinitions") or []:
    if entry.get("name") == os.environ["FSS_NAME"]:
        print(entry.get("image", ""))
        break
')"
  case "$image" in
    *@sha256:*) digest="sha256:${image##*@sha256:}" ;;
    *) rehearsal_fail "$family registers '$image', which is a tag rather than a digest, and a tag cannot carry the comparison the wrapper makes." ;;
  esac
  rehearsal_log "$service: $family is registered at $digest; its --selftest must accept schema $RANGES_CURRENT"
  ranges_selftest "schema-overlap-$service" "$service" "$definition" "$digest" 0 \
    || rehearsal_fail "$family did not start against schema $RANGES_CURRENT, which its declared range $RANGES_PREVIOUS accepts."
  RANGES_VERDICT=ran_exit_0
}

ranges_stale() {
  local service=$1 stale=$2 digest=$3
  local family="${RANGES_PREFIX}-${service}" definition
  rehearsal_log "$service: a task definition declaring {$stale,$stale} must be refused at startup"
  definition="$(ranges_definition "$family")" || exit 1
  [ -n "$definition" ] \
    || rehearsal_fail "nothing registers $family, so there is no image here to refuse anything. The apply registers it and deploy.sh release deploys it; a run that reached this step without one has not deployed what this step is about."
  if ! ranges_selftest "schema-stale-$service" "$service" "$definition" "$digest" "$SCHEMA_REFUSAL_EXIT_CODE" \
    --env "FSS_SCHEMA_MIN=$stale" --env "FSS_SCHEMA_MAX=$stale"; then
    echo "FAIL: $family did not refuse the declared range {$stale,$stale} at startup." >&2
    echo "      The wrapper's line above says what the container did: exit 0 is the image accepting" >&2
    echo "      a range it does not support, and any other code is a stop for some other reason —" >&2
    echo "      neither is the refusal this case measures (expected exit $SCHEMA_REFUSAL_EXIT_CODE)." >&2
    exit 1
  fi
  rehearsal_log "$service: refused {$stale,$stale} at startup with exit $SCHEMA_REFUSAL_EXIT_CODE, which is this case's assertion"
  RANGES_VERDICT="refused_exit_$SCHEMA_REFUSAL_EXIT_CODE"
}

# ---------------------------------------------------------------------------
# teardown: in four steps and in this order, each treating the AWS code for absence as
# done, because `if: always()` brings it here after a creation that may never have run
# (the first credentialed rehearsal, Actions 35548888865, stopped at its first step).
#   1. every one-off task still running in the run's cluster: a running task holds an
#      interface in a subnet the destroy is about to delete, and the destroy then waits on
#      the subnet until it times out. Each task ARN is classified first, so another run's
#      task, or production's, is never a candidate;
#   2. the journal objects, every version and delete marker, with
#      --bypass-governance-retention: the bucket is GOVERNANCE-locked for a day and a
#      rehearsal is same-day (infra-apply-runbook.md 3.1; the grant is the rehearsal role's
#      alone, release.md 1.2);
#   3. `terraform destroy` of the root, with every variable the create step wrote to
#      run.auto.tfvars.json beside it;
#   4. the journal bucket itself, if the destroy left it: Terraform removes only what its
#      state holds, and the first orphan teardown (Actions 35649752231) left a bucket whose
#      policy, lock, versioning and public-access block were the only things in state. It
#      is named `<prefix>-suppression-journal-<account>` (infra/modules/journal), with the
#      account of the session proved above; an empty bucket deletes whatever its lock says.
# Until W3-S8 two more steps deleted the drill's restored instance and its manual
# snapshots. Nothing in a schema rehearsal creates either: the rehearsal database is
# destroyed with skip_final_snapshot and its automated backups (infra/roots/rehearsal).
# ---------------------------------------------------------------------------
rehearsal_teardown() {
  local prefix=${1:-} aws bucket running task_arn versions markers batch destroyed state status
  rehearsal_require_prefix "$prefix" || exit 1
  rehearsal_require_deployment_session "${FSS_REHEARSAL_DEPLOYMENT_ROLE:-fss-rh-deploy}"
  bucket="${FSS_REHEARSAL_JOURNAL_BUCKET:-${prefix}-suppression-journal-${REHEARSAL_SESSION_ACCOUNT}}"
  rehearsal_refuse_production_arguments "$bucket" "${prefix}-cluster" || exit 1
  aws="$(rehearsal_aws_command)"

  rehearsal_log "1/4 stopping any one-off task still running in ${prefix}-cluster"
  running="$(rehearsal_tolerate_absent "listing running tasks in ${prefix}-cluster" \
    command "$aws" ecs list-tasks --cluster "${prefix}-cluster" --desired-status RUNNING --query 'taskArns' --output text)" || exit 1
  for task_arn in $running; do
    [ "$task_arn" != None ] || continue
    # `.../task/<cluster>/<id>`: the classifier sees the cluster name.
    if [ "$(rehearsal_classify_name "$prefix" "${task_arn##*:task/}" || true)" != rehearsal-run ]; then
      rehearsal_log "not this run's task, leaving it alone: $task_arn"
      continue
    fi
    rehearsal_tolerate_absent "stopping $task_arn" \
      command "$aws" ecs stop-task --cluster "${prefix}-cluster" --task "$task_arn" --reason "rehearsal teardown" >/dev/null || exit 1
  done

  rehearsal_log "2/4 emptying the object-locked journal bucket with bypass-governance"
  versions="$(rehearsal_tolerate_absent "listing versions in $bucket" \
    command "$aws" s3api list-object-versions --bucket "$bucket" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json)" || exit 1
  markers="$(rehearsal_tolerate_absent "listing delete markers in $bucket" \
    command "$aws" s3api list-object-versions --bucket "$bucket" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json)" || exit 1
  for batch in "$versions" "$markers"; do
    [ -n "$batch" ] || continue
    [ "$(release_json_path "$batch" Objects '[]')" != '[]' ] || continue
    rehearsal_tolerate_absent "emptying $bucket" \
      command "$aws" s3api delete-objects --bucket "$bucket" --bypass-governance-retention --delete "$batch" || exit 1
  done

  rehearsal_log "3/4 destroying the rehearsal root"
  set +e
  state="$(rehearsal_state_list)"
  status=$?
  set -e
  if [ "$status" -eq 3 ]; then
    destroyed=nothing_created
  elif [ "$status" -ne 0 ]; then
    exit 1
  elif [ -z "$state" ]; then
    rehearsal_log "the rehearsal state is empty, so this run created nothing to destroy"
    destroyed=nothing_created
  else
    # destroy needs every variable apply did, and this shell has none of the create step's
    # values: they are in run.auto.tfvars.json (identifiers only; infra/.gitignore).
    [ -f run.auto.tfvars.json ] \
      || rehearsal_fail "run.auto.tfvars.json is absent beside the rehearsal root, so terraform destroy has no values for the variables the root requires; recreate it as docs/greenfield/release.md section 3 step 13 describes and rerun this teardown"
    rehearsal_terraform destroy -auto-approve -input=false "$REHEARSAL_NO_ASSUME_VAR" -var="name_prefix=${prefix}"
    destroyed=true
  fi

  rehearsal_log "4/4 removing the journal bucket if the destroy left it"
  rehearsal_tolerate_absent "deleting $bucket" command "$aws" s3api delete-bucket --bucket "$bucket" || exit 1

  # A teardown that reported success and left an RDS instance, a load balancer and a
  # distribution behind is run 35944594998, so it answers for itself rather than leaving
  # it to the guard step, which a job that stopped early may never reach.
  rehearsal_require_nothing_left "$prefix" "the teardown" || exit 1
  rehearsal_write_report "teardown.txt" "prefix=$prefix destroyed=$destroyed journal_bucket=gone nothing_left=true"
  rehearsal_log "torn down, and nothing in the cloud carries $prefix; rehearsal.sh guard $prefix reads it again and proves nothing production's was addressed"
}

# ---------------------------------------------------------------------------
# leftovers: everything still carrying the run prefix, from the cloud rather than from
# Terraform state (review of PR 292). A create interrupted part-way leaves resources the
# state never recorded — on run 35944594998 an RDS instance, a load balancer and a
# CloudFront distribution — and `terraform destroy` cannot see them, so a teardown that
# reported success left them running and billing. An empty state proves only that the
# state is empty.
#
# Five readings, because no one API sees everything:
#   1. the Resource Groups Tagging API, every resource whose Name tag is the prefix or
#      begins `<prefix>-`. This is the wide net, and it needs tag:GetResources;
#   2. RDS instances and manual snapshots by identifier prefix — an instance mid-creation
#      carries no tag yet, and the tagging API is eventually consistent about it;
#   3. CloudFront distributions whose comment or whose origin names the prefix —
#      `list-distributions` shows a distribution the moment it exists, tagged or not;
#   4. log groups whose name begins `/fss/<prefix>` or `<prefix>`;
#   5. the two lock records of this run's state key: the S3 `<key>.tflock` object and the
#      DynamoDB item, either of which blocks the next run of the same prefix.
#
# Set aside, with a line saying so: what AWS keeps listing after it has accepted the
# deletion. Every `ecs` ARN (a stopped task for about an hour, a deleted service or
# cluster while INACTIVE, a deregistered task-definition revision for good); an `ec2`
# `network-interface/` (a Fargate task's interface goes with its task); `ec2`
# `security-group/` and `security-group-rule/` (run 36209569741 found one group and eight
# rules still listed that `describe-security-groups` answered `InvalidGroup.NotFound`);
# `kms` `key/` (a key is only ever scheduled for deletion); and `rds` `auto-backup:`.
# A security group that really stayed keeps the run's VPC, and the VPC is compared.
#
# It prints `<class> <identifier>` per leftover and exits 0 whatever it finds; the caller
# decides. `guard` and `teardown` both call it.   rehearsal_leftovers <fss-rh-run>
# ---------------------------------------------------------------------------

# bucket, key and table of this run's Terraform state, from the root's backend.hcl unless
# named. The key is the one the workflow initialises per run.
rehearsal_state_location() {
  local prefix=$1 root backend
  root="${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}"
  backend="$root/backend.hcl"
  REHEARSAL_STATE_BUCKET="${FSS_REHEARSAL_STATE_BUCKET:-}"
  REHEARSAL_LOCK_TABLE="${FSS_REHEARSAL_LOCK_TABLE:-}"
  if [ -r "$backend" ]; then
    [ -n "$REHEARSAL_STATE_BUCKET" ] || REHEARSAL_STATE_BUCKET="$(sed -n 's/^ *bucket *= *"\([^"]*\)".*/\1/p' "$backend" | head -1)"
    [ -n "$REHEARSAL_LOCK_TABLE" ] || REHEARSAL_LOCK_TABLE="$(sed -n 's/^ *dynamodb_table *= *"\([^"]*\)".*/\1/p' "$backend" | head -1)"
  fi
  REHEARSAL_STATE_KEY="${FSS_REHEARSAL_STATE_KEY:-fss/greenfield/rehearsal/$prefix/terraform.tfstate}"
  case "$REHEARSAL_STATE_KEY" in
    fss/greenfield/rehearsal/*) ;;
    *) rehearsal_fail "the state key '$REHEARSAL_STATE_KEY' is not under fss/greenfield/rehearsal/, and a rehearsal never addresses another key" ;;
  esac
}

# The tagging API's wide net, with the settling classes set aside.
rehearsal_tagged_leftovers() {
  local prefix=$1 listed
  # shellcheck disable=SC2016 # a JMESPath expression, not a shell one
  listed="$(rehearsal_aws resourcegroupstaggingapi get-resources --tag-filters "Key=Name" \
    --query 'ResourceTagMappingList[].{arn:ResourceARN,name:Tags[?Key==`Name`]|[0].Value}' --output json)" \
    || rehearsal_fail "the resources tagged for $prefix could not be listed; the guard cannot say the run left nothing"
  FSS_JSON="$listed" FSS_PREFIX="$prefix" python3 - <<'PY'
# rehearsal-tagged-leftovers
import json, os, sys
env = os.environ
prefix = env["FSS_PREFIX"]
rows = json.loads(env["FSS_JSON"] or "[]") or []
SETTLING = (
    ("ecs", "", "ECS"),
    ("ec2", "network-interface/", "network interface"),
    ("ec2", "security-group/", "security group"),
    ("ec2", "security-group-rule/", "security group rule"),
    ("kms", "key/", "KMS key"),
    ("rds", "auto-backup:", "retained automated backup"),
)

def settling(arn):
    parts = arn.split(":", 5)
    if len(parts) != 6 or parts[0] != "arn":
        return None
    service, resource = parts[2], parts[5]
    for wanted, start, kind in SETTLING:
        if service == wanted and resource.startswith(start):
            return kind
    return None

counts = {}
for row in rows:
    name, arn = row.get("name"), row.get("arn")
    if not isinstance(name, str) or not isinstance(arn, str):
        continue
    if name != prefix and not name.startswith(prefix + "-"):
        continue
    kind = settling(arn)
    if kind is None:
        print("tagged " + arn)
    else:
        counts[kind] = counts.get(kind, 0) + 1
if counts:
    sys.stderr.write("set aside, because AWS keeps listing them after it accepted the deletion: "
                     + ", ".join("%d %s" % (counts[kind], kind) for kind in sorted(counts)) + "\n")
PY
}

# RDS by identifier: an instance being created carries no tag yet.
rehearsal_rds_leftovers() {
  local prefix=$1 instances snapshots
  instances="$(rehearsal_aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output json)" \
    || rehearsal_fail "the RDS instances could not be listed; the guard cannot say the run left none"
  snapshots="$(rehearsal_aws rds describe-db-snapshots --snapshot-type manual \
    --query 'DBSnapshots[].DBSnapshotIdentifier' --output json)" \
    || rehearsal_fail "the RDS snapshots could not be listed; the guard cannot say the run left none"
  FSS_INSTANCES="$instances" FSS_SNAPSHOTS="$snapshots" FSS_PREFIX="$prefix" python3 - <<'PY'
# rehearsal-rds-leftovers
import json, os
env = os.environ
prefix = env["FSS_PREFIX"]
for variable, kind in (("FSS_INSTANCES", "database"), ("FSS_SNAPSHOTS", "snapshot")):
    for name in json.loads(env[variable] or "[]") or []:
        if isinstance(name, str) and (name == prefix or name.startswith(prefix + "-")):
            print("{} {}".format(kind, name))
PY
}

# CloudFront: a distribution is visible the moment it exists, tagged or not.
rehearsal_cloudfront_leftovers() {
  local prefix=$1 listed
  listed="$(rehearsal_aws cloudfront list-distributions \
    --query 'DistributionList.Items[].{id:Id,comment:Comment,origins:Origins.Items[].DomainName}' --output json)" \
    || rehearsal_fail "the CloudFront distributions could not be listed; the guard cannot say the run left none"
  FSS_JSON="$listed" FSS_PREFIX="$prefix" python3 - <<'PY'
# rehearsal-cloudfront-leftovers
import json, os
env = os.environ
prefix = env["FSS_PREFIX"]
for item in json.loads(env["FSS_JSON"] or "[]") or []:
    if not isinstance(item, dict):
        continue
    comment = item.get("comment") or ""
    origins = [value for value in item.get("origins") or [] if isinstance(value, str)]
    if prefix in comment or any(origin.startswith(prefix + "-") or origin.startswith(prefix + ".") for origin in origins):
        print("distribution {}".format(item.get("id") or "<no id>"))
PY
}

# Log groups by name: a group outlives the tasks that wrote to it.
rehearsal_log_group_leftovers() {
  local prefix=$1 start listed
  for start in "/fss/$prefix" "$prefix"; do
    listed="$(rehearsal_aws logs describe-log-groups --log-group-name-prefix "$start" \
      --query 'logGroups[].logGroupName' --output json)" \
      || rehearsal_fail "the log groups beginning $start could not be listed; the guard cannot say the run left none"
    FSS_JSON="$listed" python3 -c '
import json, os
for name in json.loads(os.environ["FSS_JSON"] or "[]") or []:
    if isinstance(name, str):
        print("log group " + name)
'
  done
}

# The two lock records of this run's state key: either blocks the next run of the prefix.
rehearsal_lock_leftovers() {
  local prefix=$1 output status
  rehearsal_state_location "$prefix"
  [ -n "$REHEARSAL_STATE_BUCKET" ] && [ -n "$REHEARSAL_LOCK_TABLE" ] \
    || rehearsal_fail "the state bucket and lock table could not be read from ${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}/backend.hcl, so the run's locks cannot be checked"
  set +e
  output="$(rehearsal_aws s3api head-object --bucket "$REHEARSAL_STATE_BUCKET" --key "$REHEARSAL_STATE_KEY.tflock" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "state lock s3://$REHEARSAL_STATE_BUCKET/$REHEARSAL_STATE_KEY.tflock"
  else
    case "$output" in
      *"(404)"* | *Not\ Found* | *NoSuchKey*) ;;
      *) printf '%s\n' "$output" >&2; rehearsal_fail "the state lock object could not be read, and not because it is gone" ;;
    esac
  fi
  output="$(rehearsal_aws dynamodb get-item --table-name "$REHEARSAL_LOCK_TABLE" \
    --key "{\"LockID\":{\"S\":\"$REHEARSAL_STATE_BUCKET/$REHEARSAL_STATE_KEY\"}}" --query 'Item.LockID.S' --output text)" \
    || rehearsal_fail "the state lock item could not be read from $REHEARSAL_LOCK_TABLE"
  case "$output" in
    '' | None) ;;
    *) echo "state lock dynamodb:$REHEARSAL_LOCK_TABLE/$output" ;;
  esac
}

rehearsal_leftovers() {
  local prefix=${1:-}
  rehearsal_require_prefix "$prefix" || exit 1
  rehearsal_refuse_production_arguments "$prefix" || exit 1
  rehearsal_tagged_leftovers "$prefix"
  rehearsal_rds_leftovers "$prefix"
  rehearsal_cloudfront_leftovers "$prefix"
  rehearsal_log_group_leftovers "$prefix"
  rehearsal_lock_leftovers "$prefix"
}

# The same reading, up to FSS_REHEARSAL_SETTLING_READS times a minute apart, because the
# tagging API lags a deletion. Fails naming what is left.
#   rehearsal_require_nothing_left <prefix> <what is asking>
rehearsal_require_nothing_left() {
  local prefix=$1 who=$2 reads attempt left='' status
  reads=${FSS_REHEARSAL_SETTLING_READS:-5}
  for attempt in $(seq 1 "$reads"); do
    # A reading runs in a subshell, so its refusal is a status, not an exit: "it is gone"
    # and "I was not allowed to look" must not report the same thing.
    set +e
    left="$(rehearsal_leftovers "$prefix")"
    status=$?
    set -e
    [ "$status" -eq 0 ] || return 1
    [ -n "$left" ] || break
    rehearsal_log "$who: $(printf '%s\n' "$left" | wc -l | tr -d ' ') resource(s) still carry $prefix (read $attempt of $reads)"
    [ "$attempt" -eq "$reads" ] || sleep "${FSS_REHEARSAL_SETTLING_SECONDS:-60}"
  done
  [ -n "$left" ] || return 0
  printf '%s\n' "$left" | sed 's/^/  /' >&2
  rehearsal_fail "$who: $(printf '%s\n' "$left" | wc -l | tr -d ' ') resource(s) still carry $prefix after $reads read(s), above. They are outside the run's Terraform state or the destroy did not take them; delete them by name (release.md 3.1) and run stage=teardown again."
}

# ---------------------------------------------------------------------------
# guard: Appendix G 39's cloud half, on every run, after the teardown. Four facts:
#   1. `terraform state list` is empty (or the root was never initialised): the teardown
#      destroyed everything the run's state held, and nothing in it was production's;
#   2. the session is an assumed-role session of fss-rh-deploy, whose policy is scoped to
#      fss-rh-* and cannot address fss-prod*;
#   3. nothing in the cloud still carries the run prefix (`leftovers`, above), read again
#      while the tagging API settles. This is the half an empty state cannot answer;
#   4. neither lock record of the run's state key is left, which `leftovers` also reads.
# P7 replaced the old before/after inventory comparison, which had to learn every shape
# AWS keeps listing after it accepted a deletion (lanes G47, G52, g97) and which compared
# production until g97. The reading stays; what is gone is the comparison. After a
# teardown the right answer is absolute — nothing carries the prefix — so there is nothing
# to record beforehand and nothing to diff, and the settling classes are set aside by
# name, in one place, with a line saying which.
# That nothing production's was touched rests, as before, on no rehearsal command naming
# production (lib.sh refuses at the call), the session, and the role's policy.
# ---------------------------------------------------------------------------
rehearsal_guard() {
  local prefix=${1:-} state state_read=true offending status
  rehearsal_require_prefix "$prefix" || exit 1
  rehearsal_log "asserting the run left nothing in its state or in the cloud, and touched nothing production's"

  set +e
  state="$(rehearsal_state_list)"
  status=$?
  set -e
  case "$status" in
    0) ;;
    3) state_read=false state='' ;;
    *) exit 1 ;;
  esac
  if [ -n "$state" ]; then
    offending="$(printf '%s\n' "$state" | grep -F "$PRODUCTION_PREFIX" || true)"
    [ -z "$offending" ] || rehearsal_fail "the rehearsal state names production resources: $(printf '%s' "$offending" | paste -sd ' ' -)"
    rehearsal_fail "the teardown left $(printf '%s\n' "$state" | wc -l | tr -d ' ') resource(s) in the run's state: $(printf '%s' "$state" | head -5 | paste -sd ' ' -)"
  fi

  rehearsal_require_deployment_session "${FSS_REHEARSAL_DEPLOYMENT_ROLE:-fss-rh-deploy}"

  rehearsal_require_nothing_left "$prefix" "the guard" || exit 1

  rehearsal_write_report "prefix-guard.txt" \
    "prefix=$prefix production_untouched=true state_empty=true nothing_left=true state_read=$state_read"
  rehearsal_log "pass: the run's state is empty, nothing in the cloud carries $prefix, and nothing production's was addressed"
}

# ===========================================================================
if rehearsal_dry_run; then
  rehearsal_fail "rehearsal.sh has no dry run (P7). test/ops/scenario39.check.ts and scenario22.check.ts drive it against stub CLIs."
fi
REHEARSAL_SUBCOMMAND=${1:-}
shift || true
case "$REHEARSAL_SUBCOMMAND" in
  prefix) rehearsal_prefix "$@" ;;
  identity) rehearsal_identity "$@" ;;
  run-task) rehearsal_run_task "$@" ;;
  ranges) rehearsal_ranges "$@" ;;
  teardown) rehearsal_teardown "$@" ;;
  leftovers) rehearsal_leftovers "$@" ;;
  guard) rehearsal_guard "$@" ;;
  *) rehearsal_usage ;;
esac
