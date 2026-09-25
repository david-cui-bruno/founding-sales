#!/usr/bin/env bash
# Stop both services before the apply of a schema-change release (lane g70).
#
#   infra/scripts/release-stop.sh <root> <prefix> [--environment production]
#
#   infra/scripts/release-stop.sh infra/roots/rehearsal  fss-rh-0925                         # CI, a standing stack only
#   infra/scripts/release-stop.sh infra/roots/production fss-prod --environment production   # the operator
#
# ## Why this is its own step, before the apply
#
# Every declared schema range from migration 0006 onwards is a strict `{N,N}`, so the
# task definitions a schema-change release registers refuse the schema the database is
# still at: both binaries exit 12 (`configurationInvalid`) at startup. Until 25 September
# the stop was step 1 of `release-deploy.sh`, which runs *after* `terraform apply`. The
# apply had already pointed both running services at those task definitions, so ECS was
# replacing working tasks with tasks that refuse to start before anything stopped them:
# the worker's replace-first deployment took its only task away, the API's rolling one
# churned beside the old tasks, and the circuit breaker could roll either back to the
# old revision while the script was scaling it. The 25 September 04:41Z deploy of
# schema 16 ran in exactly that order (`docs/greenfield/release.md` 8.0af).
#
# So the order of a schema-change release is now:
#
#   release-stop.sh  ->  terraform apply  ->  release-deploy.sh --schema-change
#
# and the apply cannot restart what this stopped: the two services carry
# `ignore_changes = [desired_count]` (`infra/modules/cluster/main.tf`), so an apply
# replaces their task definitions and leaves the count where this script put it.
# `release-deploy.sh` owns the count from there: it refuses a schema change unless both
# services are already at zero, and scales them to the root's declared counts only
# after `fss migrate` and `fss verify` have passed.
#
# ## What it does
#
# API first, so no request reaches a schema that is about to move; then the worker,
# which is given its stop timeout to release its job leases. Each is scaled to zero and
# waited on until ECS reports it stable, and then read back: desired, running and
# pending must all be zero, or this fails naming the counts. A service already at zero
# is left alone and reported, so running this twice is the same as running it once.
#
# ## Production
#
# The same code path in both environments, like `release-deploy.sh`: the environment
# comes from the prefix, the root must agree with it, every AWS call goes through the
# symmetric refusal in `release-common.sh`, and the cluster must be a full ARN in this
# account, region and namespace, tagged as this environment. And one extra word, as
# `release-bootstrap-workspace.sh` asks: this command takes production down, so it is
# named out loud (`--environment production`) or refused.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command and needs no credential.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

ROOT_DIRECTORY=${1:-}
PREFIX=${2:-}
shift 2 2>/dev/null || true

NAMED_ENVIRONMENT=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --environment) NAMED_ENVIRONMENT=${2:-}; shift; [ "$#" -gt 0 ] && shift ;;
    *) echo "FAIL: release-stop.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

if [ -z "$ROOT_DIRECTORY" ] || [ -z "$PREFIX" ]; then
  echo "usage: release-stop.sh <terraform root> <name prefix> [--environment production]" >&2
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
  echo "FAIL: '$PREFIX' is the production namespace and this command scales both of its services to zero." >&2
  echo "      That is the outage a schema-change release takes on purpose, so production is named out loud or not at all:" >&2
  echo "      re-run with --environment production." >&2
  exit 1
fi

REPORTS="$(rehearsal_report_dir)"
mkdir -p "$REPORTS"

rehearsal_log "stopping $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT) before the apply"

# ---------------------------------------------------------------------------
# From the root's own outputs, as release-deploy.sh reads them. The state already
# holds both services: this runs only against a stack that is standing.
# ---------------------------------------------------------------------------
CLUSTER_ARN="$(release_output "$ROOT_DIRECTORY" cluster_arn)"
DEPLOYMENT_PLAN="$(release_output "$ROOT_DIRECTORY" deployment_plan json)"

API_SERVICE="$(release_json_path "${DEPLOYMENT_PLAN:-}" "api.service_name" "${PREFIX}-api")"
WORKER_SERVICE="$(release_json_path "${DEPLOYMENT_PLAN:-}" "worker.service_name" "${PREFIX}-worker")"

REGION="${AWS_REGION:-us-east-1}"
CALLER_ACCOUNT="$(release_caller_account)"
ACCOUNT="${FSS_RELEASE_ACCOUNT:-$CALLER_ACCOUNT}"

# The credentials in this shell belong to the account this release names.
if [ -n "$CALLER_ACCOUNT" ] && [ "$CALLER_ACCOUNT" != "$ACCOUNT" ]; then
  echo "FAIL: these credentials belong to account $CALLER_ACCOUNT and this release is in $ACCOUNT" >&2
  exit 1
fi

# A full cluster ARN in this account, region and namespace. A dry run with no
# fixture has no ARN to judge, and says so rather than inventing one.
if [ -n "$CLUSTER_ARN" ] || ! rehearsal_dry_run; then
  release_require_arn "the cluster" "$CLUSTER_ARN" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1
fi

# Both service names are this environment's. The plan names them; a stale shell or
# a hand-edited output must not turn a rehearsal stop into a production one.
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

# The cluster says which environment it is, and it must agree.
TAG="$(release_cluster_environment_tag "$ENVIRONMENT" "$CLUSTER_ARN")"
if [ -n "$TAG" ] && [ "$TAG" != "$ENVIRONMENT" ]; then
  echo "FAIL: the cluster is tagged Environment=$TAG and this is a $ENVIRONMENT stop" >&2
  exit 1
fi

rehearsal_log "cluster $CLUSTER_ARN"
rehearsal_log "services $API_SERVICE, then $WORKER_SERVICE"

SUMMARY=''

stop_service() { # stop_service <service>
  local service=$1 counts desired running pending
  counts="$(release_service_counts "$ENVIRONMENT" "$CLUSTER_ARN" "$service")" || return 1

  if [ -z "$counts" ]; then
    if ! rehearsal_dry_run; then
      echo "FAIL: nothing reported the counts of $service" >&2
      return 1
    fi
    # Dry run: no counts to read, so print the whole of what a real run would do.
    release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$service" --desired-count 0 \
      --query 'service.[serviceName,desiredCount]' --output text || return 1
    release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$service" || return 1
    release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$service" || return 1
    SUMMARY="$SUMMARY $service=planned"
    return 0
  fi

  read -r desired running pending <<<"$counts"
  if [ "$desired" = "0" ] && [ "$running" = "0" ] && [ "$pending" = "0" ]; then
    rehearsal_log "$service is already stopped (desired 0, running 0, pending 0); nothing to do"
    SUMMARY="$SUMMARY $service=already_stopped"
    return 0
  fi

  rehearsal_log "$service: desired $desired, running $running, pending $pending; scaling to zero"
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$service" --desired-count 0 \
    --query 'service.[serviceName,desiredCount]' --output text || return 1
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$service" || {
    echo "FAIL: $service did not become stable at zero; read its events with aws ecs describe-services" >&2
    return 1
  }
  # Read back rather than trust the waiter: stable means running equals desired for
  # one deployment, and what the next step needs is all three counts at zero.
  release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$service" || return 1
  SUMMARY="$SUMMARY $service=stopped_from_$desired"
  return 0
}

rehearsal_log "1/2 $API_SERVICE to zero"
stop_service "$API_SERVICE" || exit 1

rehearsal_log "2/2 $WORKER_SERVICE to zero"
stop_service "$WORKER_SERVICE" || exit 1

rehearsal_write_report "release-stop.txt" "prefix=$PREFIX environment=$ENVIRONMENT${SUMMARY}"
rehearsal_log "stopped: $API_SERVICE, then $WORKER_SERVICE. Next: the apply, then release-deploy.sh --schema-change."
