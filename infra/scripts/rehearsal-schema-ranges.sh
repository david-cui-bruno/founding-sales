#!/usr/bin/env bash
# Appendix G 22: "Old API with new worker and reverse across every expand/contract
# phase obey schema ranges."
#
#   infra/scripts/rehearsal-schema-ranges.sh <fss-rh-run>
#
# The deploy order is migrate, then worker, then API (coordinator note, 20 September).
# This script runs that order against the rehearsal environment and then runs the two
# reverse cases, which is the part a unit test cannot: an image either starts or it
# does not, and `--selftest` is the cheapest way to ask it.
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
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints the plan and needs no credential.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PREFIX=${1:-}
rehearsal_require_prefix "$PREFIX"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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
# The declared order: migrate, then worker, then API.
# ---------------------------------------------------------------------------
rehearsal_log "deploy order: migrate, worker, API"
rehearsal_aws ecs update-service --cluster "${PREFIX}-cluster" --service "${PREFIX}-worker" --force-new-deployment
rehearsal_aws ecs wait services-stable --cluster "${PREFIX}-cluster" --services "${PREFIX}-worker"
rehearsal_aws ecs update-service --cluster "${PREFIX}-cluster" --service "${PREFIX}-api" --force-new-deployment
rehearsal_aws ecs wait services-stable --cluster "${PREFIX}-cluster" --services "${PREFIX}-api"

# ---------------------------------------------------------------------------
# The reverse cases. Each is a `--selftest` with a declared range that disagrees, which
# both binaries refuse (see apps/*/src/bootstrap/config.ts: SCHEMA_RANGE_DISAGREES).
# ---------------------------------------------------------------------------
refusal_for() { # refusal_for <binary minimum> <binary maximum> <schema version>
  local minimum=$1 maximum=$2 version=$3
  if [ "$version" -lt "$minimum" ]; then echo database_behind_binary
  elif [ "$version" -gt "$maximum" ]; then echo database_ahead_of_binary
  else echo accepted
  fi
}

overlaps=0
for pair in "api:$api_min:$api_max" "worker:$worker_min:$worker_max"; do
  IFS=: read -r service minimum maximum <<<"$pair"
  previous_verdict="$(refusal_for "$previous_min" "$previous_max" "$current")"
  if [ "$previous_verdict" = accepted ]; then
    overlaps=$((overlaps + 1))
    rehearsal_log "$service: the previous release's range {$previous_min,$previous_max} accepts schema $current, so the overlap case runs"
    rehearsal_aws ecs run-task --cluster "${PREFIX}-cluster" \
      --task-definition "${PREFIX}-${service}-previous" --overrides '{"containerOverrides":[{"name":"'"$service"'","command":["--selftest"]}]}'
  else
    rehearsal_log "$service: no overlap. The previous image refuses schema $current with $previous_verdict, which is the assertion."
  fi

  # And the forward case that must always refuse: a task definition declaring a range
  # one below the image's minimum is a stale deployment, whatever the numbers become.
  stale=$((minimum - 1))
  rehearsal_log "$service: a task definition declaring {$stale,$stale} must be refused at startup"
  if rehearsal_dry_run; then
    rehearsal_plan "run ${PREFIX}-${service} --selftest with FSS_SCHEMA_MIN=$stale FSS_SCHEMA_MAX=$stale -> expect non-zero"
  else
    if command aws ecs run-task --cluster "${PREFIX}-cluster" \
        --task-definition "${PREFIX}-${service}" \
        --overrides "{\"containerOverrides\":[{\"name\":\"$service\",\"command\":[\"--selftest\"],\"environment\":[{\"name\":\"FSS_SCHEMA_MIN\",\"value\":\"$stale\"},{\"name\":\"FSS_SCHEMA_MAX\",\"value\":\"$stale\"}]}]}" \
        --query 'tasks[0].taskArn' --output text >/dev/null; then
      echo "FAIL: ${PREFIX}-${service} accepted a declared schema range it does not support" >&2
      exit 1
    fi
  fi
done

rehearsal_write_report "schema-ranges.txt" \
  "api={$api_min,$api_max} worker={$worker_min,$worker_max} previous={$previous_min,$previous_max} schema=$current overlapping_pairs=$overlaps"
rehearsal_log "Appendix G 22 complete: $overlaps overlapping pair(s), the rest asserted as refusals"
