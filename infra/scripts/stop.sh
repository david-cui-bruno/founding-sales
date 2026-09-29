#!/usr/bin/env bash
# Stop both services before the apply of a schema-change release (lane g70; P7).
#
#   infra/scripts/stop.sh <root> <prefix> [--environment production]
#
# The task definitions a schema release registers declare a strict `{N,N}` range and
# refuse the schema the database is still at, so the order is
#
#   stop.sh  ->  terraform apply  ->  deploy.sh release --schema-change
#
# and the apply cannot restart what this stopped (`ignore_changes = [desired_count]`).
# The API first, so no request reaches a schema about to move, then the worker, which is
# given its stop timeout to release its job leases. Each is scaled to zero, waited on,
# and read back: desired, running and pending must all be zero. A service already at
# zero is left alone, so running this twice is running it once. Production is named out
# loud. Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every command.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

NAMED_ENVIRONMENT=''
[ "$#" -ge 2 ] || { echo "usage: stop.sh <terraform root> <name prefix> [--environment production]" >&2; exit 1; }
STOP_ROOT=$1
STOP_PREFIX=$2
shift 2
while [ "$#" -gt 0 ]; do
  case "$1" in
    --environment) NAMED_ENVIRONMENT=${2:-}; shift; [ "$#" -gt 0 ] && shift ;;
    *) echo "FAIL: stop.sh does not take '$1'" >&2; exit 1 ;;
  esac
done

release_read_root "$STOP_ROOT" "$STOP_PREFIX" "$NAMED_ENVIRONMENT" \
  "scales both of its services to zero, the outage a schema-change release takes on purpose"
mkdir -p "$(rehearsal_report_dir)"
rehearsal_log "stopping $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT) before the apply"
release_guard_services stop
rehearsal_log "services $API_SERVICE, then $WORKER_SERVICE"

SUMMARY=''
stop_service() { # stop_service <service>
  local service=$1 counts desired running pending
  counts="$(release_service_counts "$ENVIRONMENT" "$CLUSTER_ARN" "$service")" || return 1
  if [ -z "$counts" ]; then
    rehearsal_dry_run || { echo "FAIL: nothing reported the counts of $service" >&2; return 1; }
    desired=planned
  else
    read -r desired running pending <<<"$counts"
    if [ "$desired" = 0 ] && [ "$running" = 0 ] && [ "$pending" = 0 ]; then
      rehearsal_log "$service is already stopped (desired 0, running 0, pending 0); nothing to do"
      SUMMARY="$SUMMARY $service=already_stopped"
      return 0
    fi
    rehearsal_log "$service: desired $desired, running $running, pending $pending; scaling to zero"
  fi
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$service" --desired-count 0 \
    --query 'service.[serviceName,desiredCount]' --output text || return 1
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$service" \
    || { echo "FAIL: $service did not become stable at zero; read its events with aws ecs describe-services" >&2; return 1; }
  # Stable is running equal to desired for one deployment; the next step needs all three at zero.
  release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$service" || return 1
  if [ "$desired" = planned ]; then SUMMARY="$SUMMARY $service=planned"; else SUMMARY="$SUMMARY $service=stopped_from_$desired"; fi
}

rehearsal_log "1/2 $API_SERVICE to zero"
stop_service "$API_SERVICE" || exit 1
# The instant the API's last task was confirmed gone: where the interruption an operator
# feels begins, and the only place in the release that knows it (lane RS-2, PR 310 P2).
# `deploy.sh release` pairs it with the moment the API registers its targets again.
#
# Its own file, so release-stop.txt stays the one line everything already reads, and only
# for a stop that really stopped something: a service already at zero says nothing about
# when this release's outage started, and a wrong number is worse than none.
if ! rehearsal_dry_run; then
  case "$SUMMARY" in
    *"$API_SERVICE=stopped_from_"*)
      # Named with the release it belongs to. `deploy.sh release` takes the instant only
      # when the root and the prefix are its own; the apply has not happened yet, so
      # those two are the whole identity available here.
      # The root is canonicalised: the same root reaches the two scripts spelled two
      # ways — the rehearsal workflow hands stop.sh an absolute path and deploy.sh a
      # relative one — and a raw-string comparison would silently never match
      # (PR 310 third review, P2).
      rehearsal_write_report "release-stop-instant.txt" \
        "root=$(release_canonical_path "$ROOT_DIRECTORY") prefix=$PREFIX api_stopped_at=$(date -u +%s)"
      ;;
    *)
      # A stop that stopped nothing must not leave an older release's instant behind for
      # the next deploy to pair with its own scale-up (PR 310 second review, P2). The
      # marker is deleted rather than left to age out: six hours is a long time to be
      # wrong in, and `unknown` is the honest answer.
      if [ -e "$(rehearsal_report_dir)/release-stop-instant.txt" ]; then
        rm -f "$(rehearsal_report_dir)/release-stop-instant.txt"
        rehearsal_log "nothing was stopped, so the earlier stop instant is discarded"
      fi
      ;;
  esac
fi
rehearsal_log "2/2 $WORKER_SERVICE to zero"
stop_service "$WORKER_SERVICE" || exit 1

rehearsal_write_report "release-stop.txt" "prefix=$PREFIX environment=$ENVIRONMENT${SUMMARY}"
rehearsal_log "stopped: $API_SERVICE, then $WORKER_SERVICE. Next: the apply, then deploy.sh release --schema-change."
