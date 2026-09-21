#!/usr/bin/env bash
# Run one `fss` command inside the rehearsal VPC, as a one-off ECS task (lane G12h).
#
#   infra/scripts/rehearsal-run-task.sh <fss-rh-run> <step> <migration|operations> -- <command word>...
#
#   infra/scripts/rehearsal-run-task.sh fss-rh-0921 drill operations -- drill --from 2 --to 9
#
# The engine is `infra/scripts/release-common.sh`, which sources
# `infra/scripts/rehearsal-common.sh` for the production-name refusal, the dry-run
# mode and the reports directory, and which the production path uses unchanged. This
# file is the rehearsal's front door to it: it resolves the run's task definitions,
# cluster and network from `infra/roots/rehearsal`'s own outputs, and refuses a prefix
# that is not a rehearsal prefix before anything is addressed.
#
# ## What the wrapper is for
#
# The rehearsal database is private and a GitHub runner cannot reach it. Every
# database step of the restore drill therefore runs inside the VPC, on the worker
# image, and this is how. See `.context/FSS-REHEARSAL-EXECUTION-DECISION-20260921.md`
# section 4, Option A, and `docs/greenfield/release.md` section 3.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every call and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

PREFIX=${1:-}
STEP=${2:-}
KIND=${3:-}
shift 3 2>/dev/null || true
if [ "${1:-}" = "--" ]; then shift; fi

rehearsal_require_prefix "$PREFIX"

if [ -z "$STEP" ]; then
  echo "FAIL: every one-off task needs a step name. The name is what the recorded task ARN is filed under, and an unnamed step is a step a retry cannot recognise." >&2
  exit 1
fi

case "$KIND" in
  migration | operations) ;;
  *)
    echo "FAIL: '${KIND:-<empty>}' is not a task definition this rehearsal has. It is 'migration' (the DDL identity) or 'operations' (the runtime identity)." >&2
    exit 1
    ;;
esac

if [ "$#" -eq 0 ]; then
  echo "FAIL: rehearsal-run-task.sh needs a command after --." >&2
  exit 1
fi

ROOT_DIRECTORY="${FSS_REHEARSAL_ROOT:-infra/roots/rehearsal}"

CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
NETWORK_PLAN="$(release_output "$ROOT_DIRECTORY" task_network_configuration json)"
LOG_GROUP="$(release_output "$ROOT_DIRECTORY" worker_log_group_name)"
DATABASE_HOST="$(release_json_path "${NETWORK_PLAN:-}" "database_host")"

if [ "$KIND" = "migration" ]; then
  TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" migration_task_definition_arn)"
  SECRET_ARN="$(release_output "$ROOT_DIRECTORY" migration_database_secret_arn)"
else
  TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
  SECRET_ARN="$(release_output "$ROOT_DIRECTORY" app_runtime_database_secret_arn)"
fi

# The digest is the release gate at the moment of use, so it is required rather than
# defaulted: a wrapper given no digest cannot tell a task running this release's image
# from one running last release's.
WORKER_DIGEST=${FSS_RELEASE_WORKER_DIGEST:-}
if [ -z "$WORKER_DIGEST" ]; then
  echo "FAIL: FSS_RELEASE_WORKER_DIGEST is not set. The wrapper compares the registered task definition's image against the digest this release is about, and it will not launch without one." >&2
  exit 1
fi

# The restored instance (Appendix E step 1) is a *different* endpoint with the same
# credentials: a point-in-time restore copies the roles and the passwords, and only
# the hostname changes. So the endpoint travels as an environment override — a public
# identifier, safe in `describe-tasks` — and the credential stays a secret reference
# the execution role resolves. Nothing about the restored instance is ever an
# argument.
ENVIRONMENT_OVERRIDES=()
if [ -n "${FSS_RESTORED_DATABASE_HOST:-}" ]; then
  ENVIRONMENT_OVERRIDES=(--env "FSS_DATABASE_HOST=${FSS_RESTORED_DATABASE_HOST}")
  rehearsal_log "$STEP targets the restored instance at ${FSS_RESTORED_DATABASE_HOST}"
fi

release_run_task \
  ${ENVIRONMENT_OVERRIDES[@]+"${ENVIRONMENT_OVERRIDES[@]}"} \
  --step "$STEP" \
  --environment rehearsal \
  --prefix "$PREFIX" \
  --account "${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}" \
  --region "${AWS_REGION:-us-east-1}" \
  --cluster "$CLUSTER_ARN" \
  --task-definition "$TASK_DEFINITION" \
  --container "$KIND" \
  --network-plan "$NETWORK_PLAN" \
  --image-digest "$WORKER_DIGEST" \
  --database-host "${FSS_RESTORED_DATABASE_HOST:-$DATABASE_HOST}" \
  --secret-arn "$SECRET_ARN" \
  --log-group "$LOG_GROUP" \
  --log-stream-prefix "$KIND" \
  -- "$@"
