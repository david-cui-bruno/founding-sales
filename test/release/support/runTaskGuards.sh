#!/usr/bin/env bash
# Every refusal the run-task wrapper makes, exercised with no credential (lane G12h).
#
#   bash test/release/support/runTaskGuards.sh
#
# `aws ecs run-task` is the one call in a release that can do real damage with the
# wrong argument, and each guard in `infra/scripts/release-common.sh` is a judgement
# an operator used to make by reading a command line before pressing return. A guard
# that is only described is a guard nobody has seen fail, so each is run here against
# a launch it must refuse and — the other half, and the one that catches a guard that
# refuses *everything* — against a launch it must allow.
#
# Every AWS response is supplied through an `FSS_RELEASE_*` variable, so this reaches
# no network and holds no credential. `test/release/scenario39.check.ts` runs it.

set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export FSS_REHEARSAL_DRY_RUN=1
export FSS_REHEARSAL_REPORTS="${FSS_REHEARSAL_REPORTS:-$(mktemp -d)}/wrapper"
export FSS_RELEASE_CALLER_ACCOUNT=123456789012
rm -rf "$FSS_REHEARSAL_REPORTS"

# shellcheck source=infra/scripts/release-common.sh
source infra/scripts/release-common.sh

GOOD_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
OTHER_DIGEST="sha256:$(printf 'c%.0s' {1..64})"
CLUSTER="arn:aws:ecs:us-east-1:123456789012:cluster/fss-rh-check-cluster"
TASK_DEFINITION="arn:aws:ecs:us-east-1:123456789012:task-definition/fss-rh-check-migration:1"
SECRET="arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-rh-check/migration-database-a"
OTHER_SECRET="arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-rh-check/app-runtime-database-b"
NETWORK='{"subnet_ids":["subnet-1111111111111111a","subnet-1111111111111111b"],"security_group_id":"sg-1111111111111111b","assign_public_ip":"ENABLED","database_host":"fss-rh-check-pg.example","inbound_rule_count":0}'
NETWORK_WITH_INBOUND='{"subnet_ids":["subnet-1111111111111111a","subnet-1111111111111111b"],"security_group_id":"sg-1111111111111111b","assign_public_ip":"ENABLED","database_host":"fss-rh-check-pg.example","inbound_rule_count":1}'

export FSS_RELEASE_CLUSTER_TAGS='[{"key":"Environment","value":"rehearsal"}]'
export FSS_RELEASE_TASK_DEFINITION
FSS_RELEASE_TASK_DEFINITION="$(cat <<JSON
{"containerDefinitions":[{"name":"migration",
  "image":"123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@${GOOD_DIGEST}",
  "environment":[{"name":"FSS_DATABASE_HOST","value":"fss-rh-check-pg.example"}],
  "secrets":[{"name":"DATABASE_SECRET_ARN","valueFrom":"${SECRET}"}]}]}
JSON
)"

BASE=(
  --step step --environment rehearsal --prefix fss-rh-check
  --account 123456789012 --region us-east-1
  --cluster "$CLUSTER" --task-definition "$TASK_DEFINITION" --container migration
  --network-plan "$NETWORK" --image-digest "$GOOD_DIGEST"
  --database-host fss-rh-check-pg.example --secret-arn "$SECRET"
)

failures=0
proven=0

judge() { # judge <refused|allowed> <label> <command...>
  local expectation=$1 label=$2
  shift 2
  if "$@" >/dev/null 2>&1; then
    if [ "$expectation" = "refused" ]; then
      echo "GUARD_SURVIVED: the wrapper allowed $label"
      failures=$((failures + 1))
    else
      proven=$((proven + 1))
    fi
  else
    if [ "$expectation" = "allowed" ]; then
      echo "GUARD_TOO_STRICT: the wrapper refused $label, which it must allow"
      failures=$((failures + 1))
    else
      proven=$((proven + 1))
    fi
  fi
}

# The launch that must work. Without this one, every refusal below could be a
# wrapper that refuses everything, which is the way a guard suite passes vacuously.
judge allowed "the launch this release actually makes" \
  release_run_task "${BASE[@]}" -- migrate

# (d) full ARNs, in this account, in this region, in this namespace.
judge refused "a bare cluster name instead of an ARN" \
  release_run_task --step step --environment rehearsal --prefix fss-rh-check \
  --account 123456789012 --region us-east-1 \
  --cluster fss-rh-check-cluster --task-definition "$TASK_DEFINITION" --container migration \
  --network-plan "$NETWORK" --image-digest "$GOOD_DIGEST" -- migrate

judge refused "a cluster in another region" \
  release_run_task --step step --environment rehearsal --prefix fss-rh-check \
  --account 123456789012 --region eu-west-1 \
  --cluster "$CLUSTER" --task-definition "$TASK_DEFINITION" --container migration \
  --network-plan "$NETWORK" --image-digest "$GOOD_DIGEST" -- migrate

judge refused "a cluster in another account" \
  release_run_task --step step --environment rehearsal --prefix fss-rh-check \
  --account 999999999999 --region us-east-1 \
  --cluster "$CLUSTER" --task-definition "$TASK_DEFINITION" --container migration \
  --network-plan "$NETWORK" --image-digest "$GOOD_DIGEST" -- migrate

judge refused "a cluster outside this run's namespace" \
  release_run_task --step step --environment rehearsal --prefix fss-rh-other \
  --account 123456789012 --region us-east-1 \
  --cluster "$CLUSTER" --task-definition "$TASK_DEFINITION" --container migration \
  --network-plan "$NETWORK" --image-digest "$GOOD_DIGEST" -- migrate

# (a) the credentials in this shell.
judge refused "credentials belonging to another account" \
  env FSS_RELEASE_CALLER_ACCOUNT=999999999999 bash -c \
  'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" -- migrate

# (c) the cluster's own Environment tag.
judge refused "a cluster tagged Environment=production" \
  env FSS_RELEASE_CLUSTER_TAGS='[{"key":"Environment","value":"production"}]' bash -c \
  'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" -- migrate

# (e) the digest, which is the release gate at the moment of use.
judge refused "an image that is not this release's digest" \
  release_run_task "${BASE[@]}" --image-digest "$OTHER_DIGEST" -- migrate

# (g) the database and the credential entry.
judge refused "a task definition resolving another entry's credential" \
  release_run_task "${BASE[@]}" --secret-arn "$OTHER_SECRET" -- migrate

judge refused "a task definition pointed at another database" \
  release_run_task "${BASE[@]}" --database-host other-pg.example -- migrate

# (f) the network.
judge refused "a worker security group with an inbound rule" \
  release_run_task "${BASE[@]}" --network-plan "$NETWORK_WITH_INBOUND" -- migrate

# (h) the overrides.
judge refused "a credential-shaped environment override" \
  release_run_task "${BASE[@]}" --env 'DATABASE_PASSWORD=x' -- migrate

judge allowed "the restored instance's endpoint as an environment override" \
  release_run_task "${BASE[@]}" --env 'FSS_DATABASE_HOST=fss-rh-check-pg-restored.example' -- migrate

# (g) with (h): the drill's launch, and the two ways it has been wrong (lane g48).
# `--database-host` names the host the task definition was registered with, the
# primary, and the restored endpoint travels only as the override. Run 35962272085
# (24 September 2026) passed the restored endpoint as both and was refused after a
# restore that had succeeded; and until g48 an override that differed from
# `--database-host` switched the definition's host check off, so a wrong
# `--database-host` was accepted whenever an override came with it.
judge refused "the restored endpoint as --database-host while the definition names the primary" \
  release_run_task "${BASE[@]}" --database-host fss-rh-check-pg-restored.example \
  --env 'FSS_DATABASE_HOST=fss-rh-check-pg-restored.example' -- drill

judge refused "a --database-host other than the definition's, even with a restored-endpoint override" \
  release_run_task "${BASE[@]}" --database-host other-pg.example \
  --env 'FSS_DATABASE_HOST=fss-rh-check-pg-restored.example' -- drill

# And the allowed drill launch says where it is going: the target the log names is the
# override, not the host the definition was compared with.
drill_output="$(release_run_task "${BASE[@]}" --step drill-target \
  --env 'FSS_DATABASE_HOST=fss-rh-check-pg-restored.example' -- drill 2>&1)"
drill_status=$?
if [ "$drill_status" -ne 0 ]; then
  echo "GUARD_TOO_STRICT: the wrapper refused the drill launch with the primary as --database-host and the restored endpoint as the override"
  failures=$((failures + 1))
elif ! printf '%s\n' "$drill_output" | grep -qF 'drill-target: target database host fss-rh-check-pg-restored.example'; then
  echo "GUARD_SURVIVED: the drill launch did not name the restored endpoint as its target database host"
  failures=$((failures + 1))
else
  proven=$((proven + 1))
fi

# The command is an argument like any other.
judge refused "a production name in the command's own arguments" \
  release_run_task "${BASE[@]}" -- migrate --report /tmp/fss-prod-migrate.json

judge refused "no command at all" \
  release_run_task "${BASE[@]}"

# (i) the failures array: HTTP 200, no task, and a reason.
judge refused "a run-task that returned failures instead of a task" \
  env FSS_RELEASE_RUN_TASK='{"tasks":[],"failures":[{"arn":"arn:aws:ecs:us-east-1:123456789012:container-instance/x","reason":"RESOURCE:MEMORY","detail":"no capacity"}]}' \
  bash -c 'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" --step failures -- migrate

# (l) a stopped task with no exit code is not a zero.
judge refused "a task that stopped with no exit code" \
  env FSS_RELEASE_RUN_TASK='{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/aaa"}],"failures":[]}' \
  FSS_RELEASE_DESCRIBE_TASKS='{"tasks":[{"lastStatus":"STOPPED","stopCode":"TaskFailedToStart","stoppedReason":"CannotPullContainerError","containers":[{"name":"migration"}]}]}' \
  bash -c 'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" --step nocode -- migrate

# (l) every essential container, not only the one the caller named.
judge refused "a second container that exited non-zero" \
  env FSS_RELEASE_RUN_TASK='{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/bbb"}],"failures":[]}' \
  FSS_RELEASE_DESCRIBE_TASKS='{"tasks":[{"lastStatus":"STOPPED","stopCode":"EssentialContainerExited","stoppedReason":"Essential container in task exited","containers":[{"name":"migration","exitCode":0},{"name":"sidecar","exitCode":3}]}]}' \
  bash -c 'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" --step sidecar -- migrate

judge allowed "a task whose containers all exited zero" \
  env FSS_RELEASE_RUN_TASK='{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/ccc"}],"failures":[]}' \
  FSS_RELEASE_DESCRIBE_TASKS='{"tasks":[{"lastStatus":"STOPPED","stopCode":"EssentialContainerExited","stoppedReason":"Essential container in task exited","containers":[{"name":"migration","exitCode":0}]}]}' \
  bash -c 'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" --step ok -- migrate

# The symmetric namespace refusal, which is the half G12h added: the same script now
# runs in production, and a production command that named a rehearsal run would scale
# a rehearsal service and report success.
judge refused "a production command naming a rehearsal resource" \
  release_refuse_foreign_arguments production 'fss-rh-0921-cluster'
judge refused "a rehearsal command naming a production resource" \
  release_refuse_foreign_arguments rehearsal 'fss-prod-cluster'
judge allowed "a production command naming a production resource" \
  release_refuse_foreign_arguments production 'fss-prod-cluster'
judge refused "a prefix belonging to neither environment" \
  release_environment_for_prefix 'something-else'
judge refused "the empty prefix" \
  release_environment_for_prefix ''

# (o) a recorded ARN means the step already launched and nobody read how it ended: a
# retry waits on that task rather than starting a second migration, which would block
# on the advisory lock, apply nothing, and look exactly like success. Lane g80: only a
# record whose fingerprint is this invocation's, so the record is seeded with one.
record="$FSS_REHEARSAL_REPORTS/tasks/recorded.arn"
history="$FSS_REHEARSAL_REPORTS/tasks/recorded.history"
mkdir -p "$(dirname "$record")"
seed_record() { # seed_record <run id>
  printf 'arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/recorded\n' > "$record"
  printf '%s run=%s attempt=1\n' "$(release_task_fingerprint "$1" rehearsal fss-rh-check 123456789012 us-east-1 \
    "$CLUSTER" recorded "$TASK_DEFINITION" migration "$GOOD_DIGEST" fss-rh-check-pg.example "$SECRET" 0 \
    '["migrate"]' '[]')" "$1" > "${record%.arn}.fingerprint"
}
FRESH='{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/fresh"}],"failures":[]}'
PASSED='{"tasks":[{"lastStatus":"STOPPED","stopCode":"EssentialContainerExited","stoppedReason":"","containers":[{"name":"migration","exitCode":0}]}]}'
seed_record "$(release_run_id)"
FSS_RELEASE_RUN_TASK="$FRESH" FSS_RELEASE_DESCRIBE_TASKS="$PASSED" \
  release_run_task "${BASE[@]}" --step recorded -- migrate >/dev/null 2>&1
if ! grep -q 'outcome=read_verdict_0 task=arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/recorded' "$history" 2>/dev/null \
  || grep -q 'task/fss-rh-check/fresh' "$history" 2>/dev/null; then
  echo "GUARD_SURVIVED: a retry launched a second task instead of waiting on the recorded one"
  failures=$((failures + 1))
else
  proven=$((proven + 1))
fi

# (p) lane g80: a record another run wrote is never read as this one's. Its task has
# stopped, so it is set aside unread and this step launches its own.
rm -f "$history"
seed_record "another-release"
FSS_RELEASE_RUN_TASK="$FRESH" FSS_RELEASE_DESCRIBE_TASKS="$PASSED" \
  release_run_task "${BASE[@]}" --step recorded -- migrate >/dev/null 2>&1
if grep -q 'outcome=set_aside_unread_STOPPED task=arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/recorded' "$history" 2>/dev/null \
  && grep -q 'outcome=read_verdict_0 task=arn:aws:ecs:us-east-1:123456789012:task/fss-rh-check/fresh' "$history" 2>/dev/null; then
  proven=$((proven + 1))
else
  echo "GUARD_SURVIVED: a record another run wrote was read as this run's"
  failures=$((failures + 1))
fi

# (q) lane g80: an image that could not be pulled is launched again, a bounded number
# of times, and then fails; an exit code is not retried at all.
judge refused "a task whose image could not be pulled on any attempt" \
  env RELEASE_PULL_BACKOFF_SECONDS=0 FSS_RELEASE_RUN_TASK="$FRESH" \
  FSS_RELEASE_DESCRIBE_TASKS='{"tasks":[{"lastStatus":"STOPPED","stopCode":"TaskFailedToStart","stoppedReason":"CannotPullContainerError: failed to resolve ref: not found","containers":[{"name":"migration","reason":"CannotPullContainerError: not found"}]}]}' \
  bash -c 'source infra/scripts/release-common.sh; release_run_task "$@"' _ "${BASE[@]}" --step pull -- migrate
if [ "$(grep -c 'outcome=image_not_pulled_attempt_' "$FSS_REHEARSAL_REPORTS/tasks/pull.history" 2>/dev/null)" = "2" ]; then
  proven=$((proven + 1))
else
  echo "GUARD_SURVIVED: a pull failure was not launched again exactly twice before failing"
  failures=$((failures + 1))
fi

echo "${proven} wrapper guard(s) exercised, ${failures} problem(s)."
[ "$failures" -eq 0 ]
