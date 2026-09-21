#!/usr/bin/env bash
# The deployment, in the one order that works, for both environments (lane G12h).
#
#   infra/scripts/release-deploy.sh <root> <prefix> [--schema-change] [--api-digest D] [--worker-digest D]
#
#   infra/scripts/release-deploy.sh infra/roots/rehearsal  fss-rh-0921 --schema-change   # CI
#   infra/scripts/release-deploy.sh infra/roots/production fss-prod    --schema-change   # David, locally
#
# ## What this replaces, and why
#
# Until 21 September nothing in deployment ever ran a database migration. The step
# named "Migrate forward, then deploy the worker, then the API" redeployed two ECS
# services and did nothing else, while both binaries refuse to start unless the
# applied schema version is exactly the range they declare. On a fresh database that
# is two services that will never start and no command that would fix it.
#
# ## The order, and David's conditions of 21 September
#
#   1. scale to zero — on a bootstrap the apply already created them there; on a
#      schema release this script does it, API first so no request reaches a schema
#      that is about to move, then worker;
#   2. `fss migrate` — as a one-off ECS task, under the migration task role, with the
#      migration credential, inside the VPC because the database is private;
#   3. `fss admin database-users ensure` — idempotent; the `app_runtime` login user
#      the services connect as, and the `migration` membership the next release's
#      migrate checks for;
#   4. `fss verify` — schema version, configured parts, and a write/read transaction
#      that commits nothing, run as the *runtime* identity so that a pass means the
#      credential the services are about to use actually reaches the database;
#   5. worker to its declared count, and wait for it to be stable;
#   6. API to its declared count, and wait;
#   7. `fss verify` again, against the running deployment. A release gate after every
#      deploy, which is the point of having one.
#
# Stop-during-migration is the policy (`docs/greenfield/release.md` 4.1): every
# declared range from migration 0006 onwards is a strict `{N,N}`, so there is no
# version of the software that straddles a schema change and no honest way to do this
# without an outage. **The database never rolls back.** After a successful migration
# and a failed deployment the path is forward repair or the restore protocol, never
# an attempt to undo the schema.
#
# ## One code path, two environments
#
# Production applies stay local and are David's (`fss-prod-deploy` trusts no OIDC
# subject, by decision); the rehearsal runs in CI. They run this script. The
# difference is the credentials in the shell and the root in argument one, and
# `release-common.sh` refuses a rehearsal command that names production *and* a
# production command that names a rehearsal run.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

SCHEMA_CHANGE=0
API_DIGEST=''
WORKER_DIGEST=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --schema-change) SCHEMA_CHANGE=1; shift ;;
    --api-digest) API_DIGEST=$2; shift 2 ;;
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    *) echo "FAIL: release-deploy.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ]; then
  echo "usage: release-deploy.sh <terraform root> <name prefix> [--schema-change] [--api-digest D] [--worker-digest D]" >&2
  exit 1
fi

ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")"

# The root and the prefix must be the same environment. A production root deployed
# under a rehearsal prefix would read a rehearsal plan and scale production's
# services; the reverse would point CI at the production state key.
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

rehearsal_log "deploying $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT), schema_change=$SCHEMA_CHANGE"

# ---------------------------------------------------------------------------
# Everything is read from the root's own outputs. Nothing below is a literal a
# person has to keep in step with a plan.
# ---------------------------------------------------------------------------
CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
MIGRATION_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" migration_task_definition_arn)"
OPERATIONS_TASK_DEFINITION="$(release_output "$ROOT_DIRECTORY" operations_task_definition_arn)"
MIGRATION_SECRET_ARN="$(release_output "$ROOT_DIRECTORY" migration_database_secret_arn)"
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

# The digests. In a rehearsal they are the workflow's inputs; locally they are what
# David pushed. They are what the wrapper compares the registered task definition
# against, so passing none means the digest guard cannot run — which is a refusal,
# not a default, because that guard is the release gate at the moment of use.
if [ -z "$WORKER_DIGEST" ]; then
  echo "FAIL: --worker-digest is required. The wrapper refuses to launch a task whose image is not the digest this release is about, and it cannot compare against a digest it was not given." >&2
  exit 1
fi

rehearsal_log "cluster $CLUSTER_ARN"
rehearsal_log "services $WORKER_SERVICE (-> $WORKER_TARGET) and $API_SERVICE (-> $API_TARGET); bootstrap=$BOOTSTRAP"

scale() { # scale <service> <count>
  local service=$1 count=$2
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$service" --desired-count "$count"
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$service"
}

one_off() { # one_off <step> <task definition> <container> <command word>...
  local step=$1 task_definition=$2 container=$3 secret_arn
  shift 3
  # Each task definition resolves its own credential entry, and the wrapper checks
  # that the registered reference is the one this release names. The migration task
  # and the operations task deliberately do not share an entry.
  if [ "$container" = "migration" ]; then
    secret_arn=$MIGRATION_SECRET_ARN
  else
    secret_arn=$RUNTIME_SECRET_ARN
  fi
  release_run_task \
    --step "$step" \
    --environment "$ENVIRONMENT" \
    --prefix "$PREFIX" \
    --account "$ACCOUNT" \
    --region "$REGION" \
    --cluster "$CLUSTER_ARN" \
    --task-definition "$task_definition" \
    --container "$container" \
    --network-plan "$NETWORK_PLAN" \
    --image-digest "$WORKER_DIGEST" \
    --database-host "$DATABASE_HOST" \
    --secret-arn "$secret_arn" \
    --log-group "$LOG_GROUP" \
    --log-stream-prefix "$container" \
    -- "$@"
}

# ---------------------------------------------------------------------------
# 1. Stop, if this release moves the schema.
#
# API first: a request served against a schema that is about to move is the one
# thing an ordered shutdown can prevent, and the worker holds job leases it should
# be allowed to finish releasing.
# ---------------------------------------------------------------------------
if [ "$SCHEMA_CHANGE" = "1" ] && [ "$BOOTSTRAP" != "true" ]; then
  rehearsal_log "1/7 stop-during-migration: scaling both services to zero"
  scale "$API_SERVICE" 0
  scale "$WORKER_SERVICE" 0
else
  rehearsal_log "1/7 nothing to stop: $( [ "$BOOTSTRAP" = "true" ] && echo "the apply created both services at zero" || echo "this release declares no schema change" )"
fi

# ---------------------------------------------------------------------------
# 2. Migrate. Under the migration identity, inside the VPC.
# ---------------------------------------------------------------------------
rehearsal_log "2/7 fss migrate"
one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate --report /tmp/fss-migrate.json

# ---------------------------------------------------------------------------
# 3. The two database login users.
#
# Idempotent, and run on every deployment rather than only on a bootstrap: it is the
# one thing that keeps the credential in `app-runtime-database` and the role in
# PostgreSQL the same fact, and running it once at the beginning of time is how that
# stops being true six months later.
# ---------------------------------------------------------------------------
rehearsal_log "3/7 fss admin database-users ensure"
one_off database-users "$MIGRATION_TASK_DEFINITION" migration admin database-users ensure --report /tmp/fss-users.json

# ---------------------------------------------------------------------------
# 4. Verify, before anything is scaled. The first of the two gates.
# ---------------------------------------------------------------------------
rehearsal_log "4/7 fss verify (schema, before the services start)"
one_off verify-schema "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-schema.json

# ---------------------------------------------------------------------------
# 5 and 6. Worker, then API. Never beside each other.
# ---------------------------------------------------------------------------
rehearsal_log "5/7 worker to $WORKER_TARGET"
scale "$WORKER_SERVICE" "$WORKER_TARGET"
release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$WORKER_SERVICE" --force-new-deployment
release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$WORKER_SERVICE"

rehearsal_log "6/7 API to $API_TARGET"
scale "$API_SERVICE" "$API_TARGET"
release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$API_SERVICE" --force-new-deployment
release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$API_SERVICE"

# ---------------------------------------------------------------------------
# 7. Verify again, against the deployment that is now running. The release gate.
# ---------------------------------------------------------------------------
rehearsal_log "7/7 fss verify (deployed)"
one_off verify-deployed "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-deployed.json

rehearsal_write_report "release-deploy.txt" \
  "prefix=$PREFIX environment=$ENVIRONMENT schema_change=$SCHEMA_CHANGE bootstrap=$BOOTSTRAP worker=$WORKER_TARGET api=$API_TARGET api_digest=${API_DIGEST:-unset} worker_digest=$WORKER_DIGEST"
rehearsal_log "deployed: migrate, users, verify, worker, API, verify"
