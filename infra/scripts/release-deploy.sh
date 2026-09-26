#!/usr/bin/env bash
# The deployment, in the one order that works, for both environments (lane G12h).
#
#   infra/scripts/release-deploy.sh <root> <prefix> [--schema-change] --api-digest D --worker-digest D
#       [--release-record <release-record.json>]
#   infra/scripts/release-deploy.sh <root> <prefix> --record-only --api-digest D --worker-digest D
#       --release-record <release-record.json>
#
#   infra/scripts/release-deploy.sh infra/roots/rehearsal  fss-rh-0921 --schema-change --api-digest D --worker-digest D  # CI
#   infra/scripts/release-deploy.sh infra/roots/production fss-prod    --schema-change --api-digest D --worker-digest D  # a schema release
#   infra/scripts/release-deploy.sh infra/roots/production fss-prod    --api-digest D --worker-digest D                  # app-only
#   infra/scripts/release-deploy.sh infra/roots/production fss-prod    --record-only --api-digest D --worker-digest D \
#       --release-record release-record.json                                                                        # before the apply
#
# A schema change on a standing stack runs `infra/scripts/release-stop.sh` before the
# apply and this after it; step 1 below refuses when that did not happen.
#
# ## What this replaces, and why
#
# Until 21 September nothing in deployment ever ran a database migration. The step
# named "Migrate forward, then deploy the worker, then the API" redeployed two ECS
# services and did nothing else, while both binaries refuse to start unless the
# applied schema version is exactly the range they declare. On a fresh database that
# is two services that will never start and no command that would fix it.
#
# ## Two paths, and which one a release takes
#
# `--schema-change` says the release moves the schema. It is the flag that decides
# everything below, so leave it off only for a release that adds no migration.
#
# **A schema change**, in the one order that works (David's conditions of 21 September):
#
#   1. confirm both services are at zero — on a bootstrap the apply created them
#      there; on a schema release `infra/scripts/release-stop.sh` put them there
#      *before* the apply (lane g70), and this refuses if it did not;
#   2. `fss migrate` — as a one-off ECS task, under the migration task role, with the
#      migration credential, inside the VPC because the database is private;
#   3. `fss admin database-users ensure` — idempotent; the `app_runtime` login user
#      the services connect as, and the `migration` membership the next release's
#      migrate checks for;
#   4. `fss verify` — schema version, configured parts, and a write/read transaction
#      that commits nothing, run as the *runtime* identity so that a pass means the
#      credential the services are about to use actually reaches the database;
#   5. worker to its declared count, and wait for it to be stable;
#   6. API to its declared count, and wait; then the running tasks of both services are
#      read back, and every one must carry the release's digest (lane g80, below);
#   7. `fss verify` again, against the running deployment. A release gate after every
#      deploy, which is the point of having one.
#
# **An app-only release** — no flag — is one rolling deployment of both services and
# the check that it landed, and nothing else (lane g80, audit item O03; David's release
# cadence of 25 September: app-only is deploy and smoke):
#
#   1. the declared count on both services, one `update-service` each and no forced
#      deployment: the apply that registered the new task definitions has already
#      started the rollout, and forcing another one only runs it twice;
#   2. one wait, for both services to be stable;
#   3. the running tasks of both services, every one held to the release's digest.
#
# No one-off task runs on that path. Until lane g80 it launched four — migrate, database
# users, verify, verify again — and forced a second rollout of each service after the
# apply's. The schema does not move, so there is nothing to migrate; the database users
# are what the last schema release and every bootstrap ensured, and a credential
# rotation is its own procedure (`fss admin database-users ensure --rotate-password`,
# release.md 5.1); and what `fss verify` answered, the production smoke's readiness,
# schema-range and connectivity checks answer from the API that is actually running.
# A release that does move the schema and forgot the flag is caught by step 3: its tasks
# refuse the schema at startup, the circuit breaker rolls the service back to the old
# task definition, the service is stable, and the digest it runs is not this release's.
#
# ## Why "stable" is not the end (lane g80, audit item O08)
#
# `aws ecs wait services-stable` says one deployment has the tasks it wants, not which
# deployment. Both services roll a failed deployment back to the previous revision, and
# a rolled-back service is stable. So on both paths the running tasks are read — the
# service's one deployment, the number running against the declared count, each task's
# task definition, and the digest ECS actually pulled for its `api` or `worker`
# container — and a mismatch anywhere is a failure that names what is running instead.
# That is why `--api-digest` is required as well as `--worker-digest`: it is what the
# API's tasks are held to. A dry run prints the three reads and judges nothing.
#
# And, only when `--release-record <file>` is given (lane g71): after the final verify,
# `fss admin release-record put` on the operations task, so the record is in this
# deployment's database for the admin's attestation to name. The production operator
# passes the record `release-record-from-ci.sh` wrote for the digests being deployed here
# (release.md 4.2); a record naming other digests is refused before anything else runs.
# Without the flag nothing about the deploy changes. Putting a record enables nothing: the
# API still refuses an enable unless the record's API digest is its own, and the worker
# still refuses to send unless the record's worker digest is its own (release.md 6).
#
# ## --record-only: the record before the rollout (26 September 2026)
#
# The worker admits a send only when a stored record names its own digest, so the hand
# release stores the record first:  record.sh put  ->  plan  ->  apply  ->  this script.
# `--record-only` is the old name of `record.sh put` and execs it (P7). The put at the end
# of a deploy given `--release-record` stays and answers `existing`.
#
# Stop-during-migration is the policy (`docs/greenfield/release.md` 4.1): every
# declared range from migration 0006 onwards is a strict `{N,N}`, so there is no
# version of the software that straddles a schema change and no honest way to do this
# without an outage.
#
# ## Why step 1 no longer stops anything (lane g70)
#
# The apply runs before this script, and the apply is what registers the new task
# definitions. Until 25 September step 1 scaled both services to zero here — by which
# time the apply had already pointed them, at their running counts, at task definitions
# whose strict range refuses the schema the database was still at. ECS was starting
# tasks that exit 12 and taking working ones away, and the stop arrived after the harm
# (`docs/greenfield/release.md` 8.0af). So a schema-change release is now
#
#   release-stop.sh  ->  terraform apply  ->  release-deploy.sh --schema-change
#
# and step 1 is an assertion. It refuses, naming the command, when either service is
# not already at desired, running and pending zero, and it does not scale them itself:
# a script that quietly stopped the services at this point would make the wrong order
# look like the right one. The apply cannot undo the stop, because both services carry
# `ignore_changes = [desired_count]`: the count is this script's, set in steps 5 and 6
# of a schema release, and step 1 of a rolling one, to the root's declared numbers.
# **The database never rolls back.** After a successful migration
# and a failed deployment the path is forward repair or the restore protocol, never
# an attempt to undo the schema.
#
# ## One code path, two environments
#
# Production applies stay local and are David's (`fss-prod-deploy` trusts no OIDC
# subject, by decision); the rehearsal runs in CI. They run this script. The
# difference is the credentials in the shell and the root in argument one, and
# `lib.sh` refuses a rehearsal command that names production *and* a
# production command that names a rehearsal run.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

SCHEMA_CHANGE=0
RECORD_ONLY=0
API_DIGEST=''
WORKER_DIGEST=''
RELEASE_RECORD=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --schema-change) SCHEMA_CHANGE=1; shift ;;
    --record-only) RECORD_ONLY=1; shift ;;
    --api-digest) API_DIGEST=$2; shift 2 ;;
    --worker-digest) WORKER_DIGEST=$2; shift 2 ;;
    --release-record) RELEASE_RECORD=$2; shift 2 ;;
    *) echo "FAIL: release-deploy.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ]; then
  echo "usage: release-deploy.sh <terraform root> <name prefix> [--schema-change] --api-digest D --worker-digest D [--release-record <file>]" >&2
  echo "       release-deploy.sh <terraform root> <name prefix> --record-only --api-digest D --worker-digest D --release-record <file>" >&2
  exit 1
fi
if [ "$RECORD_ONLY" = "1" ]; then
  if [ -z "$RELEASE_RECORD" ]; then
    echo "FAIL: --record-only stores a release record and does nothing else, so it needs --release-record <file>." >&2
    exit 1
  fi
  if [ "$SCHEMA_CHANGE" = "1" ]; then
    echo "FAIL: --record-only deploys nothing, so --schema-change means nothing here. Pass it to the deploy that follows." >&2
    exit 1
  fi
  if [ -z "$API_DIGEST" ] || [ -z "$WORKER_DIGEST" ]; then
    echo "FAIL: --record-only needs --api-digest and --worker-digest: the record must name exactly the release it is stored for." >&2
    exit 1
  fi
  # P7: the put before the rollout is `record.sh put`; this flag is its old name.
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/record.sh" put "$ROOT_DIRECTORY" "$PREFIX" \
    --api-digest "$API_DIGEST" --worker-digest "$WORKER_DIGEST" --release-record "$RELEASE_RECORD"
fi

# The release record, judged before anything is scaled: an fss.release-record.v1 that
# names this release's digests (lib.sh release_record_base64).
if [ -n "$RELEASE_RECORD" ]; then
  release_record_base64 "$RELEASE_RECORD" "$API_DIGEST" "$WORKER_DIGEST" > /dev/null || exit 1
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
# And the API's, which the API's running tasks are held to after the deploy (lane g80).
# A dry run judges no running task, so it prints the plan without one.
if [ -z "$API_DIGEST" ] && ! rehearsal_dry_run; then
  echo "FAIL: --api-digest is required. After the deploy every running API task must carry the digest this release is about, and nothing can be compared with a digest that was not given." >&2
  exit 1
fi
for digest in "$WORKER_DIGEST" "$API_DIGEST"; do
  if [ -n "$digest" ] && [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "FAIL: '$digest' is not an image digest (sha256:<64 hex>). A tag names whatever was pushed last; a release names one image." >&2
    exit 1
  fi
done

# A bootstrap is an empty database, which is the largest schema change there is. The
# rolling path launches no migration, so a bootstrap without the flag would start two
# services against a database they refuse.
if [ "$BOOTSTRAP" = "true" ] && [ "$SCHEMA_CHANGE" != "1" ]; then
  echo "FAIL: the plan says bootstrap=true, and a bootstrap creates an empty database. Run this with --schema-change." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The guards, before any call that changes anything, on both paths.
#
# Until lane g80 every deploy's first AWS action was a one-off task, and the wrapper
# ran these guards for it. The rolling path now starts with `update-service`, so they
# are here, as `release-stop.sh` has them: the credentials belong to this release's
# account; the cluster is a full ARN in this account, region and namespace; both
# service names are this environment's; nothing names the other environment; and the
# cluster's own `Environment` tag agrees.
# ---------------------------------------------------------------------------
if [ -n "${FSS_RELEASE_ACCOUNT:-}" ]; then
  CALLER_ACCOUNT="$(release_caller_account)"
  if [ -n "$CALLER_ACCOUNT" ] && [ "$CALLER_ACCOUNT" != "$ACCOUNT" ]; then
    echo "FAIL: these credentials belong to account $CALLER_ACCOUNT and this release is in $ACCOUNT" >&2
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
    *)
      echo "FAIL: '$service' is not a service of $PREFIX" >&2
      exit 1
      ;;
  esac
done
release_refuse_foreign_arguments "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" "$WORKER_SERVICE" || exit 1
CLUSTER_TAG="$(release_cluster_environment_tag "$ENVIRONMENT" "$CLUSTER_ARN")"
if [ -n "$CLUSTER_TAG" ] && [ "$CLUSTER_TAG" != "$ENVIRONMENT" ]; then
  echo "FAIL: the cluster is tagged Environment=$CLUSTER_TAG and this is a $ENVIRONMENT deploy" >&2
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
  # that the registered `DATABASE_SECRET_ARN` reference is the one this release
  # names. The migration task deliberately carries no runtime connection — the tool
  # never falls back to one for `migrate` — so there is nothing to check there.
  if [ "$container" = "migration" ]; then
    secret_arn=''
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
# Both paths end here: the running tasks of both services, against the digests.
#
# The worker first, then the API, and both are read before this fails, so one run
# names everything that is not this release.
# ---------------------------------------------------------------------------
refuse_not_running() { # refuse_not_running
  echo "FAIL: the services are stable and not running this release; see the lines above for what they run instead." >&2
  if [ "$SCHEMA_CHANGE" != "1" ]; then
    echo "      A release that adds a migration is a schema-change release: its tasks refuse the current schema and the" >&2
    echo "      circuit breaker rolls them back. That order is release-stop.sh, the apply, then this command with --schema-change." >&2
  fi
  exit 1
}

require_release_running() {
  local refused=0
  release_require_running_digest "$ENVIRONMENT" "$CLUSTER_ARN" "$WORKER_SERVICE" worker "$WORKER_DIGEST" "$WORKER_TARGET" || refused=1
  release_require_running_digest "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" api "$API_DIGEST" "$API_TARGET" || refused=1
  if [ "$refused" -ne 0 ]; then refuse_not_running; fi
  RUNNING_DIGESTS=verified
  if rehearsal_dry_run; then RUNNING_DIGESTS=planned; fi
}
RUNNING_DIGESTS=unchecked

if [ "$SCHEMA_CHANGE" = "1" ]; then
  # -------------------------------------------------------------------------
  # 1. Both services are already stopped.
  #
  # Stopped before the apply, by `release-stop.sh`: API first, so no request reaches a
  # schema that is about to move, then the worker, which holds job leases it should be
  # allowed to release. By the time this runs the apply has registered task definitions
  # that refuse the current schema, so a service still running here is already the
  # harm, and scaling it now would only hide the order that caused it. A bootstrap
  # passes without a stop, because the apply created both services at zero; it is
  # asserted all the same, because `bootstrap=true` against a standing stack no longer
  # scales anything (`ignore_changes`), and "the apply created them at zero" is then a
  # claim about a different apply.
  # -------------------------------------------------------------------------
  refuse_not_stopped() { # refuse_not_stopped <service>
    local stop_command="infra/scripts/release-stop.sh $ROOT_DIRECTORY $PREFIX"
    if [ "$ENVIRONMENT" = production ]; then stop_command="$stop_command --environment production"; fi
    echo "FAIL: a schema-change release starts with both services stopped, and $1 is not." >&2
    echo "      The apply has already pointed it at task definitions that refuse the current schema;" >&2
    echo "      this script no longer scales it to zero here, because by now that is too late." >&2
    echo "      The order is: $stop_command, then the apply, then this command." >&2
    exit 1
  }

  rehearsal_log "1/7 stop-during-migration: both services must already be at zero ($( [ "$BOOTSTRAP" = "true" ] && echo "the apply created them there" || echo "release-stop.sh put them there before the apply" ))"
  release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" || refuse_not_stopped "$API_SERVICE"
  release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$WORKER_SERVICE" || refuse_not_stopped "$WORKER_SERVICE"

  # -------------------------------------------------------------------------
  # 2. Migrate. Under the migration identity, inside the VPC.
  # -------------------------------------------------------------------------
  rehearsal_log "2/7 fss migrate"
  one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate --report /tmp/fss-migrate.json

  # -------------------------------------------------------------------------
  # 3. The two database login users.
  #
  # Idempotent, and run on every schema release and every bootstrap rather than only
  # the first: it is the one thing that keeps the credential in `app-runtime-database`
  # and the role in PostgreSQL the same fact, and running it once at the beginning of
  # time is how that stops being true six months later.
  # -------------------------------------------------------------------------
  rehearsal_log "3/7 fss admin database-users ensure"
  one_off database-users "$MIGRATION_TASK_DEFINITION" migration admin database-users ensure --report /tmp/fss-users.json

  # -------------------------------------------------------------------------
  # 4. Verify, before anything is scaled. The first of the two gates.
  # -------------------------------------------------------------------------
  rehearsal_log "4/7 fss verify (schema, before the services start)"
  one_off verify-schema "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-schema.json

  # -------------------------------------------------------------------------
  # 5 and 6. Worker, then API. Never beside each other. Then what they run.
  # -------------------------------------------------------------------------
  rehearsal_log "5/7 worker to $WORKER_TARGET"
  scale "$WORKER_SERVICE" "$WORKER_TARGET"
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$WORKER_SERVICE" --force-new-deployment
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$WORKER_SERVICE"

  rehearsal_log "6/7 API to $API_TARGET"
  scale "$API_SERVICE" "$API_TARGET"
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$API_SERVICE" --force-new-deployment
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$API_SERVICE"

  rehearsal_log "6/7 the running tasks of $WORKER_SERVICE and $API_SERVICE, against the release digests"
  require_release_running

  # -------------------------------------------------------------------------
  # 7. Verify again, against the deployment that is now running. The release gate.
  # -------------------------------------------------------------------------
  rehearsal_log "7/7 fss verify (deployed)"
  one_off verify-deployed "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-deployed.json
  DEPLOYED='migrate, users, verify, worker, API, running digests, verify'
else
  # -------------------------------------------------------------------------
  # The rolling path: one deployment of both services, and what they run.
  #
  # The apply has already pointed both services at the task definitions it registered
  # and ECS is rolling them, at the counts they were running. Setting the declared
  # count is the one thing left, and changing only the count starts no second
  # deployment. Not `--force-new-deployment`: that would replace every task the apply's
  # rollout has just started, for nothing.
  # -------------------------------------------------------------------------
  rehearsal_log "1/3 one rolling deployment: $WORKER_SERVICE to $WORKER_TARGET and $API_SERVICE to $API_TARGET, on the task definitions the apply registered"
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$WORKER_SERVICE" --desired-count "$WORKER_TARGET" \
    --query 'service.[serviceName,desiredCount,taskDefinition]' --output text
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$API_SERVICE" --desired-count "$API_TARGET" \
    --query 'service.[serviceName,desiredCount,taskDefinition]' --output text

  rehearsal_log "2/3 wait until both are stable"
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$WORKER_SERVICE" "$API_SERVICE" || {
    echo "FAIL: $WORKER_SERVICE and $API_SERVICE did not both become stable; read their events with aws ecs describe-services." >&2
    exit 1
  }

  rehearsal_log "3/3 the running tasks of $WORKER_SERVICE and $API_SERVICE, against the release digests"
  require_release_running
  DEPLOYED='one rolling deployment of the worker and the API, running digests'
fi

# ---------------------------------------------------------------------------
# Last, on either path, and only with --release-record: the put again — after the final
# verify of a schema release, after the running digests of a rolling one. A record already
# stored by --record-only before the apply answers `existing`, and that is the check that
# the deployment now running has its record. The apply has registered the new operations
# definition, so the task is held to this release's worker digest.
# ---------------------------------------------------------------------------
RELEASE_RECORD_OUTCOME=none
if [ -n "$RELEASE_RECORD" ]; then
  release_record_put release-record-put "$RELEASE_RECORD" "$ENVIRONMENT" "$PREFIX" "$ACCOUNT" "$REGION" "$CLUSTER_ARN" \
    "$OPERATIONS_TASK_DEFINITION" "$WORKER_DIGEST" "$NETWORK_PLAN" "$DATABASE_HOST" "$RUNTIME_SECRET_ARN" "$LOG_GROUP" || exit 1
fi

rehearsal_write_report "release-deploy.txt" \
  "prefix=$PREFIX environment=$ENVIRONMENT schema_change=$SCHEMA_CHANGE bootstrap=$BOOTSTRAP worker=$WORKER_TARGET api=$API_TARGET api_digest=${API_DIGEST:-unset} worker_digest=$WORKER_DIGEST running_digests=$RUNNING_DIGESTS release_record=$RELEASE_RECORD_OUTCOME"
rehearsal_log "deployed: $DEPLOYED${RELEASE_RECORD:+, release record}"
