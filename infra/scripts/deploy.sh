#!/usr/bin/env bash
# The deploy, in both environments and on both paths (P7, 26 September 2026).
#
#   deploy.sh release   <root> <prefix> [--schema-change] --api-digest D --worker-digest D [--release-record F]
#   deploy.sh bootstrap <root> <prefix> --worker-digest D --slug S --display-name N --admin-email E \
#                       [--time-zone Z] [--sending-domain DOMAIN] [--environment production]
#   deploy.sh current   <prefix> [--var-flags] [--compare <api_image> <worker_image> [--allow-digest-change]]
#   deploy.sh ci        check|deploy|record  (the CI path; flags under "ci" below)
#
# It replaces release-deploy.sh (release), release-bootstrap-workspace.sh (bootstrap),
# deployed-digests.sh (current) and ci-deploy-app.sh (ci), which exec it with the same
# flags. The stop before a schema release is stop.sh; the record put before the plan is
# record.sh put. Dry run (release, bootstrap): FSS_REHEARSAL_DRY_RUN=1 prints every
# command and needs no credential.
#
# ## release: after the apply, by hand in production and by CI in the rehearsal
#
# One code path, two environments: the difference is the credentials in the shell and
# the root in argument one, and lib.sh refuses a rehearsal command that names production
# and a production command that names a rehearsal run. The order of a hand release is
#
#   record.sh put  ->  plan  ->  [stop.sh ->]  apply  ->  deploy.sh release [--schema-change]
#
# because the worker admits a send only while a stored record names its own digest.
#
#   * Rolling (no flag). The apply has pointed both services at the task definitions it
#     registered and ECS is rolling them. Left: the declared count on each (one
#     update-service each, no forced second rollout), one wait for both, and the running
#     digests. No one-off task: the schema does not move, the database users are what the
#     last schema release ensured, and the production smoke answers what `fss verify`
#     would. A release that moves the schema and forgot the flag is caught by the running
#     digests: its tasks refuse the schema, the circuit breaker rolls them back, the
#     service is stable, and the digest it runs is not this release's.
#   * --schema-change (lane g70). Every declared range from migration 0006 on is a strict
#     {N,N}, so there is no version that straddles a schema change: stop.sh took both
#     services to zero before the apply (the apply cannot restart them: `ignore_changes =
#     [desired_count]`). Step 1 asserts it and refuses, naming the stop, and does not scale
#     them itself: by now the apply has pointed them at definitions that refuse the current
#     schema, and a quiet stop here would make the wrong order look right. Then `fss
#     migrate` and `fss admin database-users ensure` on the migration task (idempotent, on
#     every schema release and bootstrap: it keeps the credential in app-runtime-database
#     and the PostgreSQL role the same fact), `fss verify` on the operations task, the
#     worker and then the API to their declared counts, the running digests, and `fss
#     verify` again. A bootstrap (bootstrap=true) is an empty database, the largest schema
#     change there is, so it needs the flag. The database never rolls back.
#   * The running digests (lane g80). `wait services-stable` says one deployment has the
#     tasks it wants, not which one, and a rolled-back service is stable. So every running
#     task of both services is read and held to the release's digest and the declared
#     count, and one run names everything that is not this release.
#   * The read-back (--release-record F): the put again, on the operations task the apply
#     registered, held to this release's worker digest. It must answer `existing`: the
#     record was stored before the plan (record.sh put), and this is the check that the
#     deployment now running has it. `created` fails the deploy (the services started
#     without their record), except on a bootstrap, which had no database to put into.
#
# ## bootstrap: the first workspace and its admin (lane g39), idempotent
#
# A migrated database has no workspaces row: nobody can sign in, the scheduler has no
# canary to insert, and the smoke has nothing to judge. `fss admin workspace bootstrap`
# on the operations task; its JSON answer is taken out of the log stream, printed, and
# summarised in bootstrap-workspace.txt (the workspace UUID is what the desktop takes).
# It writes business rows, so production is named out loud (--environment production).
#
# ## current: what an operator's plan starts from (lane g91)
#
# CI deploys app changes without Terraform, so the digests of the last applied plan are
# not what runs, and the service definitions track the family's newest revision. This
# prints api_image=, worker_image=, api_schema_range= and worker_schema_range= (or the
# same as -var= flags, for `terraform plan`), refusing a service mid-rollout, a running
# task on another image, and a family whose newest ACTIVE revision is not the one that
# runs. --compare is the check right before `terraform apply`: it fails when the saved
# plan's images are not what runs (a CI deploy landed in between), unless
# --allow-digest-change says the release changes them on purpose. Read-only; the task
# read goes to stderr so stdout stays the four lines.
#
# ## ci: an app-only merge, deployed by CI (lane g91; David, 25 September 2026)
#
#   deploy.sh ci check|deploy --digests <image-digests.json> --commit <sha> --run-id <id> \
#       --run-attempt <n> --run-started <instant> --run-ended <instant> \
#       --api-range <min>-<max> --worker-range <min>-<max> [--origin https://...]  (check needs it)
#   deploy.sh ci record --before-rollout|--after-rollout <the same, without --origin> \
#       --gate-run-id <id> --cluster-name <name> --operations-family <family> \
#       --subnets <subnet-a,subnet-b> --security-group <sg-id>
#
# `.github/workflows/greenfield-deploy.yml` runs it as `fss-prod-ci-deploy`, after its own
# guard found no protected path in any commit since production's (this file never
# classifies paths: a script is itself a protected path). Every subcommand first reads and
# judges: the session is exactly that role in the production account and region; the
# cluster is tagged production; the digests file is the images run's own (this commit,
# run and attempt); each digest is the one `fss-rh-<image>:ci-<commit>` names (immutable
# tags) and was pushed inside the images run's window (lane A1); both services run at
# their declared counts with one COMPLETED deployment; and the images' schema ranges equal
# the running definitions'. Then:
#
#   * check: decision=deploy, current (already running) or manual (a schema change, from
#     the ranges or /health, or a service not at its count), to $GITHUB_OUTPUT; a manual
#     decision exits 0, an error 1.
#   * record --before-rollout: the ci-gate record (record.sh from-ci) put on the operations
#     task before the promotion, the deploy job's first write, so no new worker task starts
#     without one. The operations definition is Terraform's and does not track, so the put
#     runs the worker image of the last apply, under the worker's roles and log group.
#   * deploy: the next revision of each running definition with only the image changed,
#     described back and compared field by field (deregistered otherwise); the worker
#     rolled, waited on, held to COMPLETED and its digest, and only then the API. A revision
#     ECS rolled back is deregistered, so the newest ACTIVE revision is the one that runs;
#     the stopped tasks' stop codes and the event/reason/code fields of their log lines are
#     printed, never a raw line. No Terraform; nothing from the images commit runs here.
#   * record --after-rollout: after the smoke, both services must run the two digests, and
#     the same put must answer `existing`.
#
# Offline seams: FSS_REHEARSAL_AWS_COMMAND, FSS_GH_COMMAND (record.sh from-ci),
# FSS_CI_CALLER_IDENTITY, FSS_CI_HEALTH_JSON, FSS_CI_WAIT_ATTEMPTS, FSS_CI_ROLLOUT_READS,
# FSS_CI_ROLLOUT_SECONDS, FSS_PRODUCTION_ACCOUNT_ID and lib.sh's FSS_RELEASE_* fixtures.

DEPLOY_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$DEPLOY_SCRIPTS/lib.sh"

deploy_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

deploy_usage() { # deploy_usage [exit code]
  cat >&2 <<'USAGE'
usage: deploy.sh release   <root> <prefix> [--schema-change] --api-digest D --worker-digest D [--release-record F]
       deploy.sh bootstrap <root> <prefix> --worker-digest D --slug S --display-name N --admin-email E [--time-zone Z] [--sending-domain DOMAIN] [--environment production]
       deploy.sh current   <prefix> [--var-flags] [--compare <api_image> <worker_image> [--allow-digest-change]]
       deploy.sh ci        check|deploy|record --digests F --commit SHA --run-id ID --run-attempt N --run-started T --run-ended T --api-range MIN-MAX --worker-range MIN-MAX [--origin URL] [--before-rollout|--after-rollout --gate-run-id ID --cluster-name NAME --operations-family FAMILY --subnets IDS --security-group ID]
USAGE
  exit "${1:-2}"
}

# ---------------------------------------------------------------------------
# What a service runs, for `current` and `ci`.
#
#   deploy_read_service <current|ci> <environment> <cluster> <prefix> <service> <work> <account> <region>
#
# Writes <work>/<service>-service.json, <service>-definition.json and the facts
# <service>.json, and sets DEPLOY_DESIRED, DEPLOY_RUNNING and DEPLOY_PENDING. Both modes:
# one PRIMARY deployment that ECS calls COMPLETED, on the revision the service names; the
# revision is of the service's family, runs the service's own repository by digest in this
# account and region, and declares a schema range. `current` accepts desired zero (a
# service stopped for a schema release runs no task, and what it would run is its
# revision's) and fails a count short; `ci` returns 3 for desired zero and 4 for a count
# short (both the operator's), and needs exactly one container and the NamePrefix tag the
# CI role requires on a revision it registers.
# ---------------------------------------------------------------------------
deploy_read_service() {
  local mode=$1 environment=$2 cluster=$3 prefix=$4 service=$5 work=$6 account=$7 region=$8
  local name="$prefix-$service" facts arn status
  local -a include=()
  release_aws "$environment" ecs describe-services --cluster "$cluster" --services "$name" --output json \
    >"$work/$service-service.json" || deploy_fail "ECS did not describe $name"
  set +e
  facts="$(FSS_FILE="$work/$service-service.json" FSS_NAME="$name" FSS_MODE="$mode" python3 - <<'PY'
# deploy-read-service
import json, os, sys
name, mode = os.environ["FSS_NAME"], os.environ["FSS_MODE"]
answer = json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}
entry = next((s for s in answer.get("services") or [] if s.get("serviceName") == name), None)
if entry is None or entry.get("status") != "ACTIVE":
    sys.exit("FAIL: ECS does not describe {} as an ACTIVE service".format(name))
deployments = entry.get("deployments") or []
if len(deployments) != 1:
    sys.exit("FAIL: {} has {} deployments: a rollout is under way. Nothing is read or deployed until it has finished.".format(name, len(deployments)))
deployment = deployments[0]
if deployment.get("status") != "PRIMARY" or deployment.get("rolloutState") != "COMPLETED":
    sys.exit("FAIL: {}'s one deployment is {} with its rollout {}: a rollout is under way. Nothing is read or deployed until it has finished.".format(
        name, deployment.get("status"), deployment.get("rolloutState")))
if not deployment.get("taskDefinition") or deployment.get("taskDefinition") != entry.get("taskDefinition"):
    sys.exit("FAIL: {}'s deployment runs {} and the service names {}".format(name, deployment.get("taskDefinition"), entry.get("taskDefinition")))
counts = [entry.get(field) for field in ("desiredCount", "runningCount", "pendingCount")]
if any(not isinstance(count, int) for count in counts):
    sys.exit("FAIL: ECS did not report all three counts for {}".format(name))
desired, running, pending = counts
print(entry["taskDefinition"], desired, running, pending)
if mode == "ci" and desired == 0:
    sys.exit(3)
if running != desired or pending != 0:
    if mode == "ci":
        sys.exit(4)
    sys.exit("FAIL: {} runs {} of {} task(s) with {} pending: a rollout is under way, or an outage. Read the digests when it has finished.".format(
        name, running, desired, pending))
PY
)"
  status=$?
  set -e
  case "$status" in 0 | 3 | 4) ;; *) exit 1 ;; esac
  read -r arn DEPLOY_DESIRED DEPLOY_RUNNING DEPLOY_PENDING <<<"$facts"
  [ "$status" -eq 0 ] || return "$status"
  if [ "$mode" = ci ]; then include=(--include TAGS); fi
  release_aws "$environment" ecs describe-task-definition --task-definition "$arn" ${include[@]+"${include[@]}"} --output json \
    >"$work/$service-definition.json" || deploy_fail "ECS did not describe $arn"
  FSS_SERVICE="$service" FSS_NAME="$name" FSS_WORK="$work" FSS_ARN="$arn" FSS_ACCOUNT="$account" FSS_REGION="$region" \
    FSS_PREFIX="$prefix" FSS_MODE="$mode" FSS_DESIRED="$DEPLOY_DESIRED" python3 - <<'PY' || exit 1
# deploy-read-definition
import json, os, re, sys
env = os.environ
service, name, work, mode = env["FSS_SERVICE"], env["FSS_NAME"], env["FSS_WORK"], env["FSS_MODE"]
document = json.load(open(os.path.join(work, service + "-definition.json"), encoding="utf-8")) or {}
definition = document.get("taskDefinition") or {}
if definition.get("family") != name:
    sys.exit("FAIL: {} runs a definition of family {}, not {}".format(name, definition.get("family"), name))
containers = definition.get("containerDefinitions") or []
if mode == "ci" and (len(containers) != 1 or containers[0].get("name") != service):
    sys.exit("FAIL: {}'s definition must have exactly one container, named {}".format(name, service))
container = next((c for c in containers if c.get("name") == service), None)
if container is None:
    sys.exit("FAIL: {} has no container named {}".format(env["FSS_ARN"], service))
image = str(container.get("image", ""))
repository = "{}.dkr.ecr.{}.amazonaws.com/{}".format(env["FSS_ACCOUNT"], env["FSS_REGION"], name)
match = re.fullmatch(re.escape(repository) + r"@(sha256:[0-9a-f]{64})", image)
if not match:
    sys.exit("FAIL: {} runs '{}', which is not {} by digest (its own repository, in this account and region)".format(name, image, repository))
environment = {item.get("name"): item.get("value") for item in container.get("environment") or []}
try:
    minimum, maximum = int(environment["FSS_SCHEMA_MIN"]), int(environment["FSS_SCHEMA_MAX"])
except (KeyError, TypeError, ValueError):
    sys.exit("FAIL: {} declares no schema range".format(env["FSS_ARN"]))
tags = {tag.get("key"): tag.get("value") for tag in document.get("tags") or []}
if mode == "ci" and tags.get("NamePrefix") != env["FSS_PREFIX"]:
    sys.exit("FAIL: {}'s definition does not carry NamePrefix={}; a revision registered without it is refused by the role".format(name, env["FSS_PREFIX"]))
json.dump({
    "name": name,
    "taskDefinitionArn": definition.get("taskDefinitionArn") or env["FSS_ARN"],
    "desired": int(env["FSS_DESIRED"]),
    "repository": repository,
    "image": image,
    "digest": match.group(1),
    "schema": [minimum, maximum],
    "sendingEnabled": environment.get("FSS_SENDING_ENABLED"),
}, open(os.path.join(work, service + ".json"), "w", encoding="utf-8"))
PY
}

# deploy_field <work> <service> <field>: one fact deploy_read_service wrote.
deploy_field() {
  FSS_FILE="$1/$2.json" FSS_FIELD="$3" python3 -c '
import json, os
value = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))[os.environ["FSS_FIELD"]]
print("-".join(str(part) for part in value) if isinstance(value, list) else value)
'
}

# ===========================================================================
# release
# ===========================================================================
deploy_release() {
  local root=${1:-} prefix=${2:-}
  shift 2 2>/dev/null || true
  SCHEMA_CHANGE=0
  API_DIGEST=''
  WORKER_DIGEST=''
  RELEASE_RECORD=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --schema-change) SCHEMA_CHANGE=1; shift ;;
      --api-digest) API_DIGEST=${2:-}; shift 2 ;;
      --worker-digest) WORKER_DIGEST=${2:-}; shift 2 ;;
      --release-record) RELEASE_RECORD=${2:-}; shift 2 ;;
      *) deploy_fail "deploy.sh release does not take '$1'" ;;
    esac
  done
  if [ -z "$root" ] || [ -z "$prefix" ]; then deploy_usage 1; fi

  # The record, judged before anything is scaled: an fss.release-record.v1 naming these digests.
  if [ -n "$RELEASE_RECORD" ]; then
    release_record_base64 "$RELEASE_RECORD" "$API_DIGEST" "$WORKER_DIGEST" >/dev/null || exit 1
  fi
  release_read_root "$root" "$prefix"
  mkdir -p "$(rehearsal_report_dir)"
  rehearsal_log "deploying $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT), schema_change=$SCHEMA_CHANGE"

  # The digests every launch and every running task is held to: a refusal, not a default.
  # A dry run judges no running task, so it plans without the API's.
  [ -n "$WORKER_DIGEST" ] \
    || deploy_fail "--worker-digest is required. The wrapper refuses to launch a task whose image is not the digest this release is about, and it cannot compare against a digest it was not given."
  if [ -z "$API_DIGEST" ] && ! rehearsal_dry_run; then
    deploy_fail "--api-digest is required. After the deploy every running API task must carry the digest this release is about, and nothing can be compared with a digest that was not given."
  fi
  local digest
  for digest in "$WORKER_DIGEST" "$API_DIGEST"; do
    if [ -n "$digest" ] && [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      deploy_fail "'$digest' is not an image digest (sha256:<64 hex>). A tag names whatever was pushed last; a release names one image."
    fi
  done
  if [ "$BOOTSTRAP" = "true" ] && [ "$SCHEMA_CHANGE" != "1" ]; then
    deploy_fail "the plan says bootstrap=true, and a bootstrap creates an empty database. Run this with --schema-change."
  fi

  release_guard_services deploy
  rehearsal_log "services $WORKER_SERVICE (-> $WORKER_TARGET) and $API_SERVICE (-> $API_TARGET); bootstrap=$BOOTSTRAP"

  RUNNING_DIGESTS=unchecked
  local deployed
  if [ "$SCHEMA_CHANGE" = "1" ]; then
    rehearsal_log "1/7 stop-during-migration: both services must already be at zero ($([ "$BOOTSTRAP" = "true" ] && echo "the apply created them there" || echo "stop.sh put them there before the apply"))"
    release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" || release_refuse_not_stopped "$API_SERVICE"
    release_require_service_stopped "$ENVIRONMENT" "$CLUSTER_ARN" "$WORKER_SERVICE" || release_refuse_not_stopped "$WORKER_SERVICE"

    rehearsal_log "2/7 fss migrate"
    one_off migrate "$MIGRATION_TASK_DEFINITION" migration migrate --report /tmp/fss-migrate.json

    rehearsal_log "3/7 fss admin database-users ensure"
    one_off database-users "$MIGRATION_TASK_DEFINITION" migration admin database-users ensure --report /tmp/fss-users.json

    rehearsal_log "4/7 fss verify (schema, before the services start)"
    one_off verify-schema "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-schema.json

    rehearsal_log "5/7 worker to $WORKER_TARGET"
    release_start "$WORKER_SERVICE" "$WORKER_TARGET"
    rehearsal_log "6/7 API to $API_TARGET"
    release_start "$API_SERVICE" "$API_TARGET"

    rehearsal_log "6/7 the running tasks of $WORKER_SERVICE and $API_SERVICE, against the release digests"
    release_require_release_running

    rehearsal_log "7/7 fss verify (deployed)"
    one_off verify-deployed "$OPERATIONS_TASK_DEFINITION" operations verify --report /tmp/fss-verify-deployed.json
    deployed='migrate, users, verify, worker, API, running digests, verify'
  else
    rehearsal_log "1/3 one rolling deployment: $WORKER_SERVICE to $WORKER_TARGET and $API_SERVICE to $API_TARGET, on the task definitions the apply registered"
    release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$WORKER_SERVICE" --desired-count "$WORKER_TARGET" \
      --query 'service.[serviceName,desiredCount,taskDefinition]' --output text
    release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$API_SERVICE" --desired-count "$API_TARGET" \
      --query 'service.[serviceName,desiredCount,taskDefinition]' --output text

    rehearsal_log "2/3 wait until both are stable"
    release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$WORKER_SERVICE" "$API_SERVICE" \
      || deploy_fail "$WORKER_SERVICE and $API_SERVICE did not both become stable; read their events with aws ecs describe-services."

    rehearsal_log "3/3 the running tasks of $WORKER_SERVICE and $API_SERVICE, against the release digests"
    release_require_release_running
    deployed='one rolling deployment of the worker and the API, running digests'
  fi

  # The read-back, only with --release-record: the record stored before the plan
  # (record.sh put) is there for the deployment now running.
  RELEASE_RECORD_OUTCOME=none
  if [ -n "$RELEASE_RECORD" ]; then
    rehearsal_log "the record read back: fss admin release-record put --json-base64 \"\$RELEASE_RECORD_BASE64\" --report /tmp/fss-release-record.json (on the operations task, lib.sh release_record_put; it must answer existing)"
    release_record_put release-record-put "$RELEASE_RECORD" "$ENVIRONMENT" "$PREFIX" "$ACCOUNT" "$REGION" "$CLUSTER_ARN" \
      "$OPERATIONS_TASK_DEFINITION" "$WORKER_DIGEST" "$NETWORK_PLAN" "$DATABASE_HOST" "$RUNTIME_SECRET_ARN" "$LOG_GROUP" || exit 1
    if [ "$RELEASE_RECORD_OUTCOME" = created ] && [ "$BOOTSTRAP" != "true" ]; then
      echo "FAIL: the read-back had to create the release record: it was not stored before the rollout, so the services started without it." >&2
      echo "      It is stored now. The order is record.sh put (before the plan), the apply, then this command." >&2
      exit 1
    fi
  fi

  rehearsal_write_report "release-deploy.txt" \
    "prefix=$PREFIX environment=$ENVIRONMENT schema_change=$SCHEMA_CHANGE bootstrap=$BOOTSTRAP worker=$WORKER_TARGET api=$API_TARGET api_digest=${API_DIGEST:-unset} worker_digest=$WORKER_DIGEST running_digests=$RUNNING_DIGESTS release_record=$RELEASE_RECORD_OUTCOME"
  rehearsal_log "deployed: $deployed${RELEASE_RECORD:+, release record}"
}

# one_off <step> <task definition> <container> <command word>...
# The migration task carries no runtime connection (the tool never falls back to one for
# `migrate`), so there is no credential entry to check on it.
one_off() {
  local step=$1 task_definition=$2 container=$3 secret_arn=$RUNTIME_SECRET_ARN
  shift 3
  if [ "$container" = "migration" ]; then secret_arn=''; fi
  release_run_task --step "$step" --environment "$ENVIRONMENT" --prefix "$PREFIX" --account "$ACCOUNT" \
    --region "$REGION" --cluster "$CLUSTER_ARN" --task-definition "$task_definition" --container "$container" \
    --network-plan "$NETWORK_PLAN" --image-digest "$WORKER_DIGEST" --database-host "$DATABASE_HOST" \
    --secret-arn "$secret_arn" --log-group "$LOG_GROUP" --log-stream-prefix "$container" -- "$@"
}

# release_start <service> <count>: the declared count, then one forced deployment, each waited on.
release_start() {
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$1" --desired-count "$2"
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$1"
  release_aws "$ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$1" --force-new-deployment
  release_aws "$ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$1"
}

release_refuse_not_stopped() { # release_refuse_not_stopped <service>
  local stop_command="infra/scripts/stop.sh $ROOT_DIRECTORY $PREFIX"
  if [ "$ENVIRONMENT" = production ]; then stop_command="$stop_command --environment production"; fi
  echo "FAIL: a schema-change release starts with both services stopped, and $1 is not." >&2
  echo "      The apply has already pointed it at task definitions that refuse the current schema;" >&2
  echo "      this script no longer scales it to zero here, because by now that is too late." >&2
  echo "      The order is: $stop_command, then the apply, then this command." >&2
  exit 1
}

# Both services read before this fails, so one run names everything that is not this release.
release_require_release_running() {
  local refused=0
  release_require_running_digest "$ENVIRONMENT" "$CLUSTER_ARN" "$WORKER_SERVICE" worker "$WORKER_DIGEST" "$WORKER_TARGET" || refused=1
  release_require_running_digest "$ENVIRONMENT" "$CLUSTER_ARN" "$API_SERVICE" api "$API_DIGEST" "$API_TARGET" || refused=1
  if [ "$refused" -ne 0 ]; then
    echo "FAIL: the services are stable and not running this release; see the lines above for what they run instead." >&2
    if [ "$SCHEMA_CHANGE" != "1" ]; then
      echo "      A release that adds a migration is a schema-change release: its tasks refuse the current schema and the" >&2
      echo "      circuit breaker rolls them back. That order is stop.sh, the apply, then this command with --schema-change." >&2
    fi
    exit 1
  fi
  RUNNING_DIGESTS=verified
  if rehearsal_dry_run; then RUNNING_DIGESTS=planned; fi
}

# ===========================================================================
# bootstrap
# ===========================================================================
deploy_bootstrap() {
  local root=${1:-} prefix=${2:-}
  shift 2 2>/dev/null || true
  local slug='' display_name='' admin_email='' time_zone='' sending_domain='' named=''
  WORKER_DIGEST=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --worker-digest) WORKER_DIGEST=${2:-}; shift 2 ;;
      --slug) slug=${2:-}; shift 2 ;;
      --display-name) display_name=${2:-}; shift 2 ;;
      --admin-email) admin_email=${2:-}; shift 2 ;;
      --time-zone) time_zone=${2:-}; shift 2 ;;
      --sending-domain) sending_domain=${2:-}; shift 2 ;;
      --environment) named=${2:-}; shift 2 ;;
      *) deploy_fail "deploy.sh bootstrap does not take '$1'" ;;
    esac
  done
  if [ -z "$root" ] || [ -z "$prefix" ] || [ -z "$slug" ] || [ -z "$display_name" ] || [ -z "$admin_email" ]; then
    deploy_usage 1
  fi
  release_read_root "$root" "$prefix" "$named" \
    "writes the first workspace, the first user and the first membership of it, rows that carry a slug, an admin address and the workspace UUID a person types into the desktop"
  [ -n "$WORKER_DIGEST" ] \
    || deploy_fail "--worker-digest is required. The wrapper refuses to launch a task whose image is not the digest this release is about, and it cannot compare against a digest it was not given."
  local reports capture report_json effective_zone=${time_zone:-America/New_York} summary
  reports="$(rehearsal_report_dir)"
  mkdir -p "$reports"
  capture="$reports/bootstrap-workspace.log"
  report_json="$reports/bootstrap-workspace.json"

  rehearsal_log "bootstrapping the first workspace of $PREFIX from $ROOT_DIRECTORY ($ENVIRONMENT)"
  local sending_words=''
  if [ -n "$sending_domain" ]; then sending_words=" --sending-domain $sending_domain"; fi
  rehearsal_log "fss admin workspace bootstrap --slug $slug --display-name $display_name --admin-email $admin_email --time-zone $effective_zone$sending_words --report /tmp/fss-bootstrap.json"
  # The command as words, so the wrapper's namespace refusal reads it like any other
  # argument; an empty zone is the command's own default and is not passed.
  local -a command=(admin workspace bootstrap --slug "$slug" --display-name "$display_name" --admin-email "$admin_email" --report /tmp/fss-bootstrap.json)
  if [ -n "$time_zone" ]; then command+=(--time-zone "$time_zone"); fi
  if [ -n "$sending_domain" ]; then command+=(--sending-domain "$sending_domain"); fi
  release_run_task --step bootstrap-workspace --environment "$ENVIRONMENT" --prefix "$PREFIX" --account "$ACCOUNT" \
    --region "$REGION" --cluster "$CLUSTER_ARN" --task-definition "$OPERATIONS_TASK_DEFINITION" --container operations \
    --network-plan "$NETWORK_PLAN" --image-digest "$WORKER_DIGEST" --database-host "$DATABASE_HOST" \
    --secret-arn "$RUNTIME_SECRET_ARN" --log-group "$LOG_GROUP" --log-stream-prefix operations \
    --capture "$capture" -- "${command[@]}"

  if rehearsal_dry_run; then
    rehearsal_plan "read the task's log stream and take the JSON report out of it into $report_json"
    rehearsal_plan "print the report, whose workspace.id is what the desktop's Workspace field takes"
    rehearsal_write_report "bootstrap-workspace.txt" \
      "planned prefix=$PREFIX environment=$ENVIRONMENT slug=$slug time_zone=$effective_zone sending_domain=${sending_domain:-none} worker_digest=$WORKER_DIGEST"
    rehearsal_log "dry run: nothing was launched and no workspace exists"
    return 0
  fi
  release_captured_report "$capture" "$report_json"
  cat "$report_json"
  summary="$(FSS_REPORT="$report_json" python3 -c '
import json, os
report = json.load(open(os.environ["FSS_REPORT"], encoding="utf-8"))
workspace, admin, membership, sending = (report.get(key) or {} for key in ("workspace", "admin", "membership", "sendingDomain"))
print("workspace_id=%s slug=%s workspace=%s admin=%s membership=%s role=%s sending_domain=%s sending_domain_outcome=%s sending_domain_primary=%s" % (
    workspace.get("id", "unknown"), workspace.get("slug", "unknown"), workspace.get("outcome", "unknown"),
    admin.get("outcome", "unknown"), membership.get("outcome", "unknown"), membership.get("role", "unknown"),
    sending.get("domain", "none"), sending.get("outcome", "none"), str(sending.get("isPrimary", "none")).lower()))
')"
  rehearsal_write_report "bootstrap-workspace.txt" "prefix=$PREFIX environment=$ENVIRONMENT $summary worker_digest=$WORKER_DIGEST"
  rehearsal_log "the first workspace exists: $summary"
}

# ===========================================================================
# current
# ===========================================================================
current_usage() {
  echo "usage: deploy.sh current <prefix> [--var-flags] [--compare <api_image> <worker_image> [--allow-digest-change]]" >&2
  exit 2
}

deploy_current() {
  local prefix=${1:-}
  shift || true
  local form='' compare_api='' compare_worker='' allow=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --var-flags) form=--var-flags; shift ;;
      --compare) [ "$#" -ge 3 ] || current_usage; compare_api=$2; compare_worker=$3; shift 3 ;;
      --allow-digest-change) allow=1; shift ;;
      *) current_usage ;;
    esac
  done
  if [ "$allow" = 1 ] && [ -z "$compare_api" ]; then current_usage; fi
  local environment account region cluster work service name latest image schema lines='' pair differs='' key
  environment="$(release_environment_for_prefix "$prefix")" || exit 2
  if rehearsal_dry_run; then
    echo "FAIL: deploy.sh current only reads, and what it reads is the answer; there is nothing to dry-run" >&2
    exit 2
  fi
  account="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
  region=${AWS_REGION:-us-east-1}
  cluster="arn:aws:ecs:${region}:${account}:cluster/${prefix}-cluster"
  release_require_arn "the cluster" "$cluster" ecs "$account" "$region" "$prefix" || exit 1
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-deployed.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$work'" EXIT

  for service in api worker; do
    name="$prefix-$service"
    deploy_read_service current "$environment" "$cluster" "$prefix" "$service" "$work" "$account" "$region"
    # The family's newest ACTIVE revision is what Terraform reads (track_latest).
    latest="$(release_aws "$environment" ecs describe-task-definition --task-definition "$name" --output json)" || exit 1
    latest="$(release_json_path "$latest" taskDefinition.taskDefinitionArn)"
    if [ -n "$latest" ] && [ "$latest" != "$(deploy_field "$work" "$service" taskDefinitionArn)" ]; then
      deploy_fail "$name runs $(deploy_field "$work" "$service" taskDefinitionArn), and its family's newest ACTIVE revision is $latest. Terraform reads the newest (track_latest), so a plan now is made against a revision nothing runs. Reconcile first: if $latest is a rolled-back deploy, aws ecs deregister-task-definition --task-definition $latest with the admin profile, then run this again."
    fi
    # Every RUNNING task, held to that image's digest and the declared count; to stderr.
    image="$(deploy_field "$work" "$service" image)"
    release_require_running_digest "$environment" "$cluster" "$name" "$service" "${image##*@}" "$DEPLOY_DESIRED" >&2 \
      || deploy_fail "$name's running tasks are not all $image; read the digests when its rollout has finished"
    schema="$(deploy_field "$work" "$service" schema)"
    lines="$lines ${service}_image=$image ${service}_schema_range={min=${schema%-*},max=${schema#*-}}"
  done

  if [ -n "$compare_api" ]; then
    for pair in $lines; do
      case "$pair" in
        api_image=*) [ "${pair#api_image=}" = "$compare_api" ] || differs="$differs api (runs ${pair#api_image=}, the plan has $compare_api)" ;;
        worker_image=*) [ "${pair#worker_image=}" = "$compare_worker" ] || differs="$differs worker (runs ${pair#worker_image=}, the plan has $compare_worker)" ;;
      esac
    done
    if [ -z "$differs" ]; then
      echo "the plan's two images are the ones production runs" >&2
    elif [ "$allow" = 1 ]; then
      echo "the plan changes the image of:$differs, and --allow-digest-change says that is this release" >&2
    else
      deploy_fail "the plan's images are not the ones production runs:$differs. Applying it would put other images on the services; plan again from this script's output, or pass --allow-digest-change for a release that changes them on purpose."
    fi
  fi
  # Images first, then ranges, one per line.
  for key in api_image worker_image api_schema_range worker_schema_range; do
    for pair in $lines; do
      case "$pair" in
        "$key="*) if [ "$form" = --var-flags ]; then printf -- '-var=%s\n' "$pair"; else printf '%s\n' "$pair"; fi ;;
      esac
    done
  done
}

# ===========================================================================
# ci
# ===========================================================================
CI_PREFIX="$RELEASE_PRODUCTION_PREFIX"
CI_ENVIRONMENT=production
CI_ROLE="${CI_PREFIX}-ci-deploy"
# The production account and region; the workflow sets neither, so the defaults hold.
CI_ACCOUNT="${FSS_PRODUCTION_ACCOUNT_ID:-326255650484}"
CI_REGION="${FSS_PRODUCTION_REGION:-us-east-1}"
# The worker first, as on every path of `release`.
CI_SERVICES='worker api'
# Three of the CLI's ten-minute waits per service (the API drains for its deregistration
# delay), then up to five minutes for ECS to call the rollout COMPLETED (lane A1).
CI_WAIT_ATTEMPTS="${FSS_CI_WAIT_ATTEMPTS:-3}"
CI_ROLLOUT_READS="${FSS_CI_ROLLOUT_READS:-20}"
CI_ROLLOUT_SECONDS="${FSS_CI_ROLLOUT_SECONDS:-15}"

# One line per key, in $GITHUB_OUTPUT when the workflow gave one, and on stdout.
ci_output() {
  local key=$1 value=${2//$'\n'/ }
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"; fi
}

# The end of `check`: a decision, a reason, exit 0.
ci_decide() {
  ci_output decision "$1"
  ci_output reason "$2"
  if [ "$1" = manual ]; then echo "::notice title=Not deployed by CI; the manual path applies::$2"; fi
  exit 0
}

ci_field() { deploy_field "$CI_WORK" "$1" "$2"; }

deploy_ci() {
  SUBCOMMAND=${1:-}
  shift || true
  case "$SUBCOMMAND" in check | deploy | record) ;; *) deploy_usage 2 ;; esac
  DIGESTS='' COMMIT='' RUN_ID='' RUN_ATTEMPT='' RUN_STARTED='' RUN_ENDED='' API_RANGE='' WORKER_RANGE='' ORIGIN=''
  GATE_RUN_ID='' RECORD_CLUSTER_NAME='' OPERATIONS_FAMILY='' TASK_SUBNETS='' TASK_SECURITY_GROUP='' RECORD_STAGE=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --before-rollout) RECORD_STAGE=before; shift ;;
      --after-rollout) RECORD_STAGE=after; shift ;;
      --gate-run-id) GATE_RUN_ID=${2:-}; shift 2 ;;
      --cluster-name) RECORD_CLUSTER_NAME=${2:-}; shift 2 ;;
      --operations-family) OPERATIONS_FAMILY=${2:-}; shift 2 ;;
      --subnets) TASK_SUBNETS=${2:-}; shift 2 ;;
      --security-group) TASK_SECURITY_GROUP=${2:-}; shift 2 ;;
      --digests) DIGESTS=${2:-}; shift 2 ;;
      --commit) COMMIT=${2:-}; shift 2 ;;
      --run-id) RUN_ID=${2:-}; shift 2 ;;
      --run-attempt) RUN_ATTEMPT=${2:-}; shift 2 ;;
      --run-started) RUN_STARTED=${2:-}; shift 2 ;;
      --run-ended) RUN_ENDED=${2:-}; shift 2 ;;
      --api-range) API_RANGE=${2:-}; shift 2 ;;
      --worker-range) WORKER_RANGE=${2:-}; shift 2 ;;
      --origin) ORIGIN=${2:-}; shift 2 ;;
      *) deploy_fail "deploy.sh ci does not take '$1'" ;;
    esac
  done
  ci_arguments
  ci_read_digests
  CI_WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-ci-deploy.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$CI_WORK'" EXIT
  ci_session
  ci_provenance
  ci_production
  case "$SUBCOMMAND" in
    record) ci_record ;;
    check) ci_check ;;
    deploy) ci_deploy ;;
  esac
}

# Every argument judged before anything is asked.
ci_arguments() {
  local instant range
  if rehearsal_dry_run; then
    deploy_fail "deploy.sh ci has no dry run. Every step of check is a read, and test/ops/ciDeploy.check.ts drives it against a stub CLI."
  fi
  [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || deploy_fail "--commit '$COMMIT' is not a full forty-character commit"
  [[ "$RUN_ID" =~ ^[0-9]{1,20}$ ]] || deploy_fail "--run-id '$RUN_ID' is not a workflow run id"
  [[ "$RUN_ATTEMPT" =~ ^[0-9]{1,4}$ ]] || deploy_fail "--run-attempt '$RUN_ATTEMPT' is not a run attempt"
  for instant in "$RUN_STARTED" "$RUN_ENDED"; do
    [[ "$instant" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
      || deploy_fail "'$instant' is not a UTC instant; pass the images run's created_at and updated_at as --run-started and --run-ended"
  done
  [[ ! "$RUN_ENDED" < "$RUN_STARTED" ]] || deploy_fail "the images run ended at $RUN_ENDED, before it started at $RUN_STARTED"
  for range in "$API_RANGE" "$WORKER_RANGE"; do
    [[ "$range" =~ ^[0-9]{1,4}-[0-9]{1,4}$ ]] || deploy_fail "'$range' is not a schema range; pass <min>-<max>"
  done
  if [ "$SUBCOMMAND" = check ]; then
    [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || deploy_fail "--origin '$ORIGIN' is not an https origin; production has no port-80 listener"
  fi
  if [ "$SUBCOMMAND" != record ]; then
    [ -z "$RECORD_STAGE" ] || deploy_fail "--before-rollout and --after-rollout belong to record, not to $SUBCOMMAND"
    return 0
  fi
  [ -n "$RECORD_STAGE" ] \
    || deploy_fail "record needs --before-rollout (the deploy job's put, before its first write) or --after-rollout (the read-back after the smoke)"
  # Five public identifiers; the last four come from repository variables (release.md 4.0),
  # and an empty one is a variable nobody set.
  [[ "$GATE_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]] || deploy_fail "--gate-run-id '$GATE_RUN_ID' is not a GitHub Actions run id"
  [[ "$RECORD_CLUSTER_NAME" =~ ^${CI_PREFIX}-[a-z0-9-]{1,40}$ ]] \
    || deploy_fail "--cluster-name '$RECORD_CLUSTER_NAME' is not a ${CI_PREFIX} cluster name; set the repository variable FSS_PRODUCTION_CLUSTER_NAME (release.md 4.0)"
  [[ "$OPERATIONS_FAMILY" =~ ^${CI_PREFIX}-[a-z0-9-]{1,40}$ ]] \
    || deploy_fail "--operations-family '$OPERATIONS_FAMILY' is not a ${CI_PREFIX} task definition family; set the repository variable FSS_PRODUCTION_OPERATIONS_TASK_FAMILY (release.md 4.0)"
  [[ "$TASK_SUBNETS" =~ ^subnet-[0-9a-f]{8,17}(,subnet-[0-9a-f]{8,17}){0,5}$ ]] \
    || deploy_fail "--subnets '$TASK_SUBNETS' is not a comma-separated list of subnet ids; set the repository variable FSS_PRODUCTION_TASK_SUBNET_IDS (release.md 4.0)"
  [[ "$TASK_SECURITY_GROUP" =~ ^sg-[0-9a-f]{8,17}$ ]] \
    || deploy_fail "--security-group '$TASK_SECURITY_GROUP' is not a security group id; set the repository variable FSS_PRODUCTION_TASK_SECURITY_GROUP_ID (release.md 4.0)"
}

# The digests file the images run's publish job wrote, for exactly this commit, run and attempt.
ci_read_digests() {
  read -r API_DIGEST WORKER_DIGEST <<<"$(FSS_FILE="$DIGESTS" FSS_COMMIT="$COMMIT" FSS_RUN_ID="$RUN_ID" FSS_RUN_ATTEMPT="$RUN_ATTEMPT" python3 - <<'PY'
# deploy-ci-read-digests
import json, os, re, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

try:
    document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
except (OSError, ValueError) as error:
    fail("the digests file cannot be read: {}".format(error))
if not isinstance(document, dict) or document.get("schema") != "fss.image-digests.v1":
    fail("the digests file is not fss.image-digests.v1")
commit = os.environ["FSS_COMMIT"]
if document.get("commit") != commit:
    fail("the digests file names commit {}, and this deploy is {}".format(document.get("commit"), commit))
if str(document.get("workflowRunId")) != os.environ["FSS_RUN_ID"]:
    fail("the digests file was written by run {}, and the images run is {}".format(document.get("workflowRunId"), os.environ["FSS_RUN_ID"]))
if str(document.get("workflowRunAttempt")) != os.environ["FSS_RUN_ATTEMPT"]:
    fail("the digests file was written by attempt {} of the images run, and its latest attempt is {}".format(
        document.get("workflowRunAttempt"), os.environ["FSS_RUN_ATTEMPT"]))
images = document.get("images") or {}
found = []
for service in ("api", "worker"):
    entry = images.get(service) or {}
    if entry.get("repository") != "fss-rh-" + service:
        fail("the {} image is in '{}', not fss-rh-{}".format(service, entry.get("repository"), service))
    if entry.get("tag") != "ci-" + commit:
        fail("the {} image is tagged '{}', not ci-{}".format(service, entry.get("tag"), commit))
    digest = entry.get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        fail("the {} digest '{}' is not an image digest".format(service, digest))
    found.append(digest)
if found[0] == found[1]:
    fail("the API and worker digests are identical; one image was pushed under both names")
print(found[0], found[1])
PY
)"
  [ -n "${API_DIGEST:-}" ] && [ -n "${WORKER_DIGEST:-}" ] || exit 1
}

# The session: exactly the CI role, in the production account and region; the cluster
# tagged production.
ci_session() {
  local identity tag
  [[ "$CI_ACCOUNT" =~ ^[0-9]{12}$ ]] || deploy_fail "the production account '$CI_ACCOUNT' is not an account id"
  REGION=${AWS_REGION:-$CI_REGION}
  [ "$REGION" = "$CI_REGION" ] || deploy_fail "the session is configured for $REGION, and production is in $CI_REGION"
  if [ "${FSS_CI_CALLER_IDENTITY+set}" = "set" ]; then
    identity=$FSS_CI_CALLER_IDENTITY
  else
    identity="$(command "$(rehearsal_aws_command)" sts get-caller-identity --query Arn --output text)" \
      || deploy_fail "the session could not be identified"
  fi
  echo "caller identity: ${identity:-<none>}"
  if [[ ! "$identity" =~ ^arn:aws:sts::${CI_ACCOUNT}:assumed-role/${CI_ROLE}/[A-Za-z0-9+=,.@_-]+$ ]]; then
    deploy_fail "this session is ${identity:-<none>}, which is not an assumed-role session of arn:aws:iam::${CI_ACCOUNT}:role/${CI_ROLE}. The CI deploy acts as that role in the production account and nothing else; an operator deploys with deploy.sh release."
  fi
  ACCOUNT=$CI_ACCOUNT
  CLUSTER_ARN="arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CI_PREFIX}-cluster"
  release_require_arn "the cluster" "$CLUSTER_ARN" ecs "$ACCOUNT" "$REGION" "$CI_PREFIX" || exit 1
  tag="$(release_cluster_environment_tag "$CI_ENVIRONMENT" "$CLUSTER_ARN")"
  [ "$tag" = production ] || deploy_fail "the cluster is tagged Environment=${tag:-<none>}, and this is the production deploy"
  rehearsal_log "cluster $CLUSTER_ARN, tagged Environment=production"
}

# Provenance (lane A1): each digest is the one the rehearsal repository holds under
# ci-<commit> (the tags are immutable, so it is the first one pushed there), pushed while
# the images run was going. A read of a rehearsal repository, which release_aws refuses in
# a production command by design; so the CLI directly, with the two literal names.
ci_provenance() {
  local service expected held pushed
  for service in $CI_SERVICES; do
    expected=$API_DIGEST
    if [ "$service" = worker ]; then expected=$WORKER_DIGEST; fi
    command "$(rehearsal_aws_command)" ecr describe-images --repository-name "fss-rh-$service" --image-ids "imageTag=ci-$COMMIT" \
      --output json >"$CI_WORK/$service-source.json" || deploy_fail "ECR has no fss-rh-$service:ci-$COMMIT"
    read -r held pushed <<<"$(FSS_FILE="$CI_WORK/$service-source.json" python3 -c '
import json, os
details = (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("imageDetails") or []
detail = details[0] if len(details) == 1 else {}
print(detail.get("imageDigest") or "-", str(detail.get("imagePushedAt") or "-").replace(" ", "T"))
')"
    [ "$held" = "$expected" ] \
      || deploy_fail "fss-rh-$service:ci-$COMMIT is ${held:-<nothing>}, and the digests file says $expected: the artifact does not name the image its run published"
    # The CLI prints an ISO instant with an offset (v2) or seconds since the epoch (v1).
    FSS_PUSHED="$pushed" FSS_STARTED="$RUN_STARTED" FSS_ENDED="$RUN_ENDED" FSS_IMAGE="fss-rh-$service:ci-$COMMIT" python3 - <<'PY' \
      || deploy_fail "fss-rh-$service:ci-$COMMIT is not an image the images run $RUN_ID pushed"
# deploy-ci-pushed-within-run
import os, re, sys
from datetime import datetime, timezone
env = os.environ

def instant(text):
    text = str(text).strip()
    if re.fullmatch(r"[0-9]{9,11}(\.[0-9]{1,9})?", text):
        return datetime.fromtimestamp(float(text), tz=timezone.utc)
    match = re.fullmatch(r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:?[0-9]{2})", text)
    if not match:
        return None
    zone = "+00:00" if match.group(3) == "Z" else match.group(3)
    if len(zone) == 5:
        zone = zone[:3] + ":" + zone[3:]
    digits = (match.group(2) or ".")[1:7]
    fraction = "." + digits.ljust(6, "0") if digits else ""
    return datetime.fromisoformat(match.group(1) + fraction + zone)

pushed = instant(env["FSS_PUSHED"])
started, ended = instant(env["FSS_STARTED"]), instant(env["FSS_ENDED"])
if pushed is None:
    print("FAIL: ECR reports no push time for {} ('{}'), so which run pushed it cannot be told".format(env["FSS_IMAGE"], env["FSS_PUSHED"]), file=sys.stderr)
    sys.exit(1)
if not started <= pushed <= ended:
    print("FAIL: {} was pushed at {}, outside the images run's window {} to {}: that run did not push it".format(
        env["FSS_IMAGE"], pushed.isoformat(), env["FSS_STARTED"], env["FSS_ENDED"]), file=sys.stderr)
    sys.exit(1)
PY
    rehearsal_log "fss-rh-$service:ci-$COMMIT was pushed at $pushed, inside the images run's window $RUN_STARTED to $RUN_ENDED"
  done
  rehearsal_log "fss-rh-api and fss-rh-worker hold ci-$COMMIT as the two digests the artifact names"
}

# What each service runs now, and the schema guard's first half: the images' ranges
# against the running definitions', which a CI revision keeps.
ci_production() {
  local service status not_running='' reason mismatch=''
  for service in $CI_SERVICES; do
    status=0
    deploy_read_service ci "$CI_ENVIRONMENT" "$CLUSTER_ARN" "$CI_PREFIX" "$service" "$CI_WORK" "$ACCOUNT" "$REGION" || status=$?
    case "$status" in
      0) rehearsal_log "${CI_PREFIX}-$service runs $(ci_field "$service" taskDefinitionArn) ($(ci_field "$service" digest), schema $(ci_field "$service" schema), $(ci_field "$service" desired) task(s))" ;;
      3) not_running="$not_running; ${CI_PREFIX}-$service is at desired count zero, which is a schema release in progress" ;;
      4) not_running="$not_running; ${CI_PREFIX}-$service runs $DEPLOY_RUNNING of $DEPLOY_DESIRED task(s) with $DEPLOY_PENDING pending, which is an outage or an unfinished rollout" ;;
    esac
  done
  if [ -n "$not_running" ]; then
    reason="production is not running at its declared counts (${not_running#; }), and that is the operator's"
    if [ "$SUBCOMMAND" = check ]; then ci_decide manual "$reason"; fi
    deploy_fail "$reason"
  fi
  [ "$(ci_field api schema)" = "$API_RANGE" ] || mismatch="api"
  [ "$(ci_field worker schema)" = "$WORKER_RANGE" ] || mismatch="${mismatch:+$mismatch and }worker"
  if [ -n "$mismatch" ]; then
    reason="the images declare schema api $API_RANGE and worker $WORKER_RANGE, and production's task definitions declare api $(ci_field api schema) and worker $(ci_field worker schema): a different schema range ($mismatch) is a schema change"
    if [ "$SUBCOMMAND" = check ]; then ci_decide manual "$reason"; fi
    deploy_fail "$reason"
  fi
  ALREADY_RUNNING=0
  if [ "$(ci_field api digest)" = "$API_DIGEST" ] && [ "$(ci_field worker digest)" = "$WORKER_DIGEST" ]; then ALREADY_RUNNING=1; fi
}

# record (lane g100; before the rollout since 26 September 2026).
ci_record() {
  local reference facts revision operations_digest log_group secret_arn database_host network_plan
  if [ "$RECORD_STAGE" = after ] && [ "$ALREADY_RUNNING" -ne 1 ]; then
    deploy_fail "production runs api $(ci_field api digest) and worker $(ci_field worker digest), not the deployed api $API_DIGEST and worker $WORKER_DIGEST. The read-back after the rollout is for a deployment that runs its record's digests."
  fi
  if [ "$RECORD_STAGE" = before ] && [ "$ALREADY_RUNNING" -ne 1 ]; then
    rehearsal_log "before the rollout: production runs api $(ci_field api digest) and worker $(ci_field worker digest); the record for api $API_DIGEST and worker $WORKER_DIGEST is stored first, so no new worker task starts without one"
  fi
  [ "$RECORD_CLUSTER_NAME" = "${CI_PREFIX}-cluster" ] \
    || deploy_fail "the repository variable FSS_PRODUCTION_CLUSTER_NAME names $RECORD_CLUSTER_NAME, and this deploy acts on ${CI_PREFIX}-cluster; set it again from terraform output -raw ci_deploy_cluster_name"

  # 1. The record: GitHub only, from the gate run that was green on the images commit.
  reference="ci-gate-${GATE_RUN_ID}-${COMMIT:0:12}"
  "$DEPLOY_SCRIPTS/record.sh" from-ci "$GATE_RUN_ID" "$COMMIT" "$API_DIGEST" "$WORKER_DIGEST" --out "$CI_WORK/release-record.json" \
    || deploy_fail "record.sh from-ci wrote no record for gate run $GATE_RUN_ID; its FAIL line above says why"
  rehearsal_log "release record $reference built from gate run $GATE_RUN_ID (api $API_DIGEST, worker $WORKER_DIGEST)"

  # 2. The operations definition as ECS holds it (the family's newest ACTIVE revision,
  # which Terraform registered), judged against the worker's running one.
  release_aws "$CI_ENVIRONMENT" ecs describe-task-definition --task-definition "$OPERATIONS_FAMILY" --output json \
    >"$CI_WORK/operations-definition.json" || deploy_fail "ECS did not describe the task definition family $OPERATIONS_FAMILY"
  facts="$(FSS_OPERATIONS="$CI_WORK/operations-definition.json" FSS_WORKER="$CI_WORK/worker-definition.json" \
    FSS_FAMILY="$OPERATIONS_FAMILY" FSS_ACCOUNT="$ACCOUNT" FSS_REGION="$REGION" FSS_PREFIX="$CI_PREFIX" python3 - <<'PY'
# deploy-ci-read-operations
import json, os, re, sys
env = os.environ

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

operations = (json.load(open(env["FSS_OPERATIONS"], encoding="utf-8")) or {}).get("taskDefinition") or {}
worker = (json.load(open(env["FSS_WORKER"], encoding="utf-8")) or {}).get("taskDefinition") or {}
family = env["FSS_FAMILY"]
arn = str(operations.get("taskDefinitionArn") or "")
pattern = r"arn:aws:ecs:{}:{}:task-definition/{}:[0-9]+".format(re.escape(env["FSS_REGION"]), env["FSS_ACCOUNT"], re.escape(family))
if operations.get("family") != family or operations.get("status") != "ACTIVE" or not re.fullmatch(pattern, arn):
    fail("ECS answered {} ({}), not an ACTIVE revision of {} in this account and region".format(arn or "<nothing>", operations.get("status"), family))
containers = operations.get("containerDefinitions") or []
if len(containers) != 1 or containers[0].get("name") != "operations":
    fail("{} must have exactly one container, named operations".format(arn))
container = containers[0]
repository = "{}.dkr.ecr.{}.amazonaws.com/{}-worker".format(env["FSS_ACCOUNT"], env["FSS_REGION"], env["FSS_PREFIX"])
match = re.fullmatch(re.escape(repository) + r"@(sha256:[0-9a-f]{64})", str(container.get("image", "")))
if not match:
    fail("{} runs '{}', which is not {} by digest".format(arn, container.get("image"), repository))
for field in ("taskRoleArn", "executionRoleArn"):
    if not operations.get(field) or operations.get(field) != worker.get(field):
        fail("{} runs under {} {}, and the worker under {}: the put may pass only the worker's roles".format(
            arn, field, operations.get(field), worker.get(field)))
worker_container = (worker.get("containerDefinitions") or [{}])[0]
logs = (container.get("logConfiguration") or {}).get("options") or {}
worker_logs = (worker_container.get("logConfiguration") or {}).get("options") or {}
if not logs.get("awslogs-group") or logs.get("awslogs-group") != worker_logs.get("awslogs-group") or logs.get("awslogs-stream-prefix") != "operations":
    fail("{} logs to {} under '{}', not to the worker's group under 'operations'".format(
        arn, logs.get("awslogs-group"), logs.get("awslogs-stream-prefix")))
secret = next((item.get("valueFrom", "") for item in worker_container.get("secrets") or [] if item.get("name") == "DATABASE_SECRET_ARN"), "")
host = next((item.get("value", "") for item in worker_container.get("environment") or [] if item.get("name") == "FSS_DATABASE_HOST"), "")
if not secret:
    fail("the worker's definition names no DATABASE_SECRET_ARN to hold the operations task to")
print(arn, match.group(1), logs["awslogs-group"], secret, host or "-")
PY
)" || exit 1
  read -r revision operations_digest log_group secret_arn database_host <<<"$facts"
  if [ "$database_host" = "-" ]; then database_host=''; fi
  rehearsal_log "the put runs $revision (${CI_PREFIX}-worker@$operations_digest, the image of the last apply); the record it stores names worker $WORKER_DIGEST"

  # 3. The put (lib.sh release_record_put). The network is the one the repository
  # variables name; the worker group's zero inbound rules are what the production root's
  # isolation test holds it to.
  network_plan="$(FSS_SUBNETS="$TASK_SUBNETS" FSS_GROUP="$TASK_SECURITY_GROUP" python3 -c '
import json, os, sys
json.dump({"subnet_ids": os.environ["FSS_SUBNETS"].split(","), "security_group_id": os.environ["FSS_GROUP"],
           "assign_public_ip": "ENABLED", "inbound_rule_count": 0}, sys.stdout)
')"
  export FSS_REHEARSAL_REPORTS="${FSS_REHEARSAL_REPORTS:-$CI_WORK/reports}"
  release_record_put release-record-put "$CI_WORK/release-record.json" "$CI_ENVIRONMENT" "$CI_PREFIX" "$ACCOUNT" "$REGION" \
    "$CLUSTER_ARN" "$revision" "$operations_digest" "$network_plan" "$database_host" "$secret_arn" "$log_group" || exit 1
  if [ "$RECORD_STAGE" = after ] && [ "$RELEASE_RECORD_OUTCOME" != existing ]; then
    deploy_fail "the read-back had to create the release record $reference: it was not stored before the rollout, which the deploy job's put should have done. It is stored now."
  fi
  ci_output release_record_reference "$reference"
  ci_output release_record_outcome "$RELEASE_RECORD_OUTCOME"
  rehearsal_log "release record $reference stored ($RELEASE_RECORD_OUTCOME, ${RECORD_STAGE} the rollout): source ci-gate, api $API_DIGEST, worker $WORKER_DIGEST"
}

# check: the decision. The workflow's guard has already classified every commit since
# production's, so a range with a protected path in it never reaches this.
ci_check() {
  local verdict status
  if [ "$ALREADY_RUNNING" -eq 1 ]; then ci_decide current "production already runs api $API_DIGEST and worker $WORKER_DIGEST"; fi
  # The schema guard's second half: what the running API says about itself.
  if [ "${FSS_CI_HEALTH_JSON+set}" = "set" ]; then
    printf '%s' "$FSS_CI_HEALTH_JSON" >"$CI_WORK/health.json"
  else
    curl -fsS --max-time 15 "$ORIGIN/health" >"$CI_WORK/health.json" \
      || deploy_fail "$ORIGIN/health did not answer. A production that cannot report its schema is not one to deploy onto."
  fi
  set +e
  verdict="$(FSS_FILE="$CI_WORK/health.json" FSS_API="$API_RANGE" FSS_WORKER="$WORKER_RANGE" FSS_RUNNING="$(ci_field api schema)" python3 - <<'PY'
# deploy-ci-health
import json, os, sys
env = os.environ
try:
    schema = json.load(open(env["FSS_FILE"], encoding="utf-8"))["schema"]
    declared = "{}-{}".format(int(schema["declaredRange"]["minimum"]), int(schema["declaredRange"]["maximum"]))
    accepted = schema["accepted"]
    version = schema["databaseVersion"]
except (ValueError, KeyError, TypeError) as error:
    print("FAIL: /health is not the report this deploy reads: {}".format(error), file=sys.stderr)
    sys.exit(1)
if declared != env["FSS_RUNNING"]:
    print("FAIL: the running API declares schema {} and its task definition {}".format(declared, env["FSS_RUNNING"]), file=sys.stderr)
    sys.exit(1)
if accepted is not True or not isinstance(version, int):
    print("FAIL: production reports its schema as not accepted (version {}, reason {})".format(version, schema.get("reason")), file=sys.stderr)
    sys.exit(1)
for label in ("API", "WORKER"):
    low, high = (int(part) for part in env["FSS_" + label].split("-"))
    if not low <= version <= high:
        print("the database is at schema {}, which the {} image ({}) does not accept".format(version, label.lower(), env["FSS_" + label]))
        sys.exit(3)
print("the running API declares {} and the database is at {}".format(declared, version))
PY
)"
  status=$?
  set -e
  case "$status" in
    0) rehearsal_log "$verdict" ;;
    3) ci_decide manual "$verdict: a schema change" ;;
    *) exit 1 ;;
  esac
  ci_decide deploy "app-only: no protected path in any commit since production's, and the images declare the schema production runs (api $API_RANGE, worker $WORKER_RANGE)"
}

# deploy: the worker, then the API, each held to its digest before the next is touched.
ci_deploy() {
  local service name previous digest image revision difference observed expect_sending=disabled
  if [ "$ALREADY_RUNNING" -eq 1 ]; then
    rehearsal_log "production already runs api $API_DIGEST and worker $WORKER_DIGEST; nothing to register"
  fi
  for service in $CI_SERVICES; do
    name="${CI_PREFIX}-$service"
    previous="$(ci_field "$service" taskDefinitionArn)"
    ci_output "previous_${service}_task_definition" "$previous"
    digest=$API_DIGEST
    if [ "$service" = worker ]; then digest=$WORKER_DIGEST; fi
    if [ "$(ci_field "$service" digest)" = "$digest" ]; then
      rehearsal_log "$name already runs $digest"
      ci_output "${service}_task_definition" "$previous"
      continue
    fi
    image="$(ci_field "$service" repository)@$digest"

    # The next revision of the running definition: the same document with the read-only
    # fields removed, the same tags, and one field changed.
    FSS_SERVICE="$service" FSS_WORK="$CI_WORK" FSS_IMAGE="$image" python3 - <<'PY' || exit 1
# deploy-ci-next-revision
import json, os
env = os.environ
work, service = env["FSS_WORK"], env["FSS_SERVICE"]
document = json.load(open(os.path.join(work, service + "-definition.json"), encoding="utf-8"))
definition = dict(document["taskDefinition"])
for field in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
              "registeredAt", "registeredBy", "deregisteredAt"):
    definition.pop(field, None)
definition["containerDefinitions"] = [dict(definition["containerDefinitions"][0], image=env["FSS_IMAGE"])]
definition["tags"] = document.get("tags") or []
json.dump(definition, open(os.path.join(work, service + "-next.json"), "w", encoding="utf-8"), indent=2)
PY
    rehearsal_log "registering the next revision of $name with $digest"
    release_aws "$CI_ENVIRONMENT" ecs register-task-definition --cli-input-json "file://$CI_WORK/$service-next.json" --output json \
      >"$CI_WORK/$service-registered.json" || deploy_fail "ECS refused the next revision of $name; nothing has been rolled"
    revision="$(FSS_FILE="$CI_WORK/$service-registered.json" FSS_NAME="$name" FSS_PREVIOUS="$previous" python3 -c '
import json, os, sys
definition = (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("taskDefinition") or {}
arn = str(definition.get("taskDefinitionArn") or "")
family = arn.rsplit("/", 1)[-1].rsplit(":", 1)[0] if arn else ""
if family != os.environ["FSS_NAME"] or arn == os.environ["FSS_PREVIOUS"]:
    print("FAIL: ECS registered {}, not a new revision of {}".format(arn or "<nothing>", os.environ["FSS_NAME"]), file=sys.stderr)
    sys.exit(1)
print(arn)
')" || exit 1

    # What ECS holds, described back and compared with the running revision: the image is
    # the one field allowed to differ. Anything else different, and it is deregistered
    # before any service names it.
    release_aws "$CI_ENVIRONMENT" ecs describe-task-definition --task-definition "$revision" --include TAGS --output json \
      >"$CI_WORK/$service-new.json" || { ci_deregister "$revision" "it could not be described back"; deploy_fail "ECS did not describe $revision"; }
    if ! difference="$(FSS_RUNNING="$CI_WORK/$service-definition.json" FSS_NEW="$CI_WORK/$service-new.json" FSS_IMAGE="$image" python3 - <<'PY'
# deploy-ci-compare-revisions
import json, os, sys
env = os.environ
DERIVED = ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
           "registeredAt", "registeredBy", "deregisteredAt")

def normal(path):
    document = json.load(open(path, encoding="utf-8")) or {}
    definition = {key: value for key, value in (document.get("taskDefinition") or {}).items() if key not in DERIVED}
    containers = [dict(container) for container in definition.get("containerDefinitions") or []]
    images = [container.pop("image", None) for container in containers]
    definition["containerDefinitions"] = containers
    tags = sorted((tag.get("key"), tag.get("value")) for tag in document.get("tags") or [])
    return definition, images, tags

running, _, running_tags = normal(env["FSS_RUNNING"])
new, new_images, new_tags = normal(env["FSS_NEW"])
problems = []
if new_images != [env["FSS_IMAGE"]]:
    problems.append("image {} and not {}".format(new_images, env["FSS_IMAGE"]))
for key in sorted(set(running) | set(new)):
    if running.get(key) != new.get(key):
        problems.append("field {}".format(key))
if running_tags != new_tags:
    problems.append("tags")
if problems:
    print("; ".join(problems))
    sys.exit(1)
PY
)"; then
      ci_deregister "$revision" "it differs from $previous in more than the image"
      deploy_fail "the revision ECS registered for $name differs from the running one: $difference. Nothing was rolled."
    fi
    ci_output "${service}_task_definition" "$revision"

    rehearsal_log "rolling $name from $previous to $revision"
    release_aws "$CI_ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$name" --task-definition "$revision" \
      --output json >/dev/null || { ci_deregister "$revision" "ECS refused to roll to it"; deploy_fail "ECS refused to point $name at $revision; it still runs $previous"; }

    # Stable, then COMPLETED as ECS calls it, then every RUNNING task read and held to the
    # digest: exactly the declared count, each of the new revision, each reporting it.
    if ci_wait_stable "$name" \
      && ci_rollout_completed "$service" "$revision" "$(ci_field "$service" desired)" \
      && release_require_running_digest "$CI_ENVIRONMENT" "$CLUSTER_ARN" "$name" "$service" "$digest" "$(ci_field "$service" desired)"; then
      rehearsal_log "$name runs $digest on every task"
      continue
    fi
    ci_diagnose "$service" "$revision"
    observed="$(ci_observed "$service")"
    ci_output "observed_${service}_task_definition" "${observed:-unknown}"
    if [ "$observed" = "$previous" ]; then
      ci_deregister "$revision" "ECS rolled $name back to $previous"
      deploy_fail "$name was rolled back by ECS to $previous and does not run $digest. Nothing after it was touched."
    fi
    deploy_fail "$name names ${observed:-an unknown revision} and does not run $digest on every task; read its events with aws ecs describe-services. Nothing after it was touched."
  done
  if [ "$(ci_field api sendingEnabled)" = true ]; then expect_sending=enabled; fi
  ci_output expect_sending "$expect_sending"
  rehearsal_log "deployed: worker $WORKER_DIGEST, then api $API_DIGEST, each held to its digest"
}

# The stopped tasks of a failed rollout: stop codes, exit codes, the log stream, and the
# event, reason and code fields of each structured log line, never a raw line. An
# application log can carry a value from an ECS-injected secret, and GitHub masks only
# the secrets it was given.
ci_diagnose() {
  local service=$1 name="${CI_PREFIX}-$1" revision=$2 listed arns task
  listed="$(release_aws "$CI_ENVIRONMENT" ecs list-tasks --cluster "$CLUSTER_ARN" --service-name "$name" \
    --desired-status STOPPED --output json 2>/dev/null)" || return 0
  arns="$(FSS_JSON="$listed" python3 -c '
import json, os
print(" ".join(((json.loads(os.environ["FSS_JSON"] or "{}") or {}).get("taskArns") or [])[:5]))
')"
  [ -n "$arns" ] || { rehearsal_log "$name has no stopped task to explain it"; return 0; }
  # shellcheck disable=SC2086 # one word per task ARN
  release_aws "$CI_ENVIRONMENT" ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks $arns --output json \
    >"$CI_WORK/$service-stopped.json" 2>/dev/null || return 0
  for task in $(FSS_FILE="$CI_WORK/$service-stopped.json" FSS_REVISION="$revision" python3 -c '
import json, os, sys
for task in (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("tasks") or []:
    if task.get("taskDefinitionArn") != os.environ["FSS_REVISION"]:
        continue
    task_id = str(task.get("taskArn", "")).rsplit("/", 1)[-1]
    print("stopped task {}: {} {}".format(task_id, task.get("stopCode") or "", task.get("stoppedReason") or ""), file=sys.stderr)
    for container in task.get("containers") or []:
        print("  container {} exit {} {}".format(container.get("name"), container.get("exitCode"), container.get("reason") or ""), file=sys.stderr)
    print(task_id)
' | head -2); do
    rehearsal_log "log stream /fss/${CI_PREFIX}/$service $service/$service/$task (event, reason and code only):" >&2
    release_aws "$CI_ENVIRONMENT" logs get-log-events --log-group-name "/fss/${CI_PREFIX}/$service" \
      --log-stream-name "$service/$service/$task" --limit 20 --output json 2>/dev/null \
      | python3 -c '
import json, sys
try:
    events = (json.load(sys.stdin) or {}).get("events") or []
except ValueError:
    events = []
for event in events:
    try:
        line = json.loads(str(event.get("message", "")))
    except ValueError:
        continue
    if not isinstance(line, dict):
        continue
    kept = {key: line[key] for key in ("event", "reason", "code") if isinstance(line.get(key), (str, int))}
    if kept:
        print("  | " + " ".join("{}={}".format(key, str(value)[:80]) for key, value in kept.items()))
' >&2 || true
  done
  return 0
}

# Up to CI_WAIT_ATTEMPTS of the CLI's ten-minute waits: a waiter that gives up is not a
# rollout that failed.
ci_wait_stable() {
  local name=$1 attempt
  for attempt in $(seq 1 "$CI_WAIT_ATTEMPTS"); do
    if release_aws "$CI_ENVIRONMENT" ecs wait services-stable --cluster "$CLUSTER_ARN" --services "$name"; then
      return 0
    fi
    rehearsal_log "$name is not stable after wait $attempt of $CI_WAIT_ATTEMPTS"
  done
  return 1
}

# The rollout ECS itself calls finished (lane A1): one PRIMARY deployment, of the new
# revision, COMPLETED, the declared count running and nothing pending. A deployment still
# IN_PROGRESS can yet be rolled back by the circuit breaker, so it is read again until it
# is COMPLETED, FAILED or not this revision's, for at most CI_ROLLOUT_READS reads.
ci_rollout_completed() {
  local service=$1 name="${CI_PREFIX}-$1" revision=$2 desired=$3 attempt verdict
  for attempt in $(seq 1 "$CI_ROLLOUT_READS"); do
    release_aws "$CI_ENVIRONMENT" ecs describe-services --cluster "$CLUSTER_ARN" --services "$name" --output json \
      >"$CI_WORK/$service-rollout.json" || { echo "FAIL: ECS did not describe $name after its rollout" >&2; return 1; }
    verdict="$(FSS_FILE="$CI_WORK/$service-rollout.json" FSS_NAME="$name" FSS_REVISION="$revision" FSS_DESIRED="$desired" python3 - <<'PY'
# deploy-ci-rollout-completed
import json, os
env = os.environ
name = env["FSS_NAME"]
entry = next((s for s in (json.load(open(env["FSS_FILE"], encoding="utf-8")) or {}).get("services") or []
              if s.get("serviceName") == name), None) or {}
deployments = entry.get("deployments") or []
primary = next((d for d in deployments if d.get("status") == "PRIMARY"), {})
state = primary.get("rolloutState")
if primary.get("taskDefinition") != env["FSS_REVISION"] or entry.get("taskDefinition") != env["FSS_REVISION"]:
    print("failed its PRIMARY deployment is {}, not {}".format(primary.get("taskDefinition"), env["FSS_REVISION"]))
elif state == "FAILED":
    print("failed its deployment FAILED: {}".format(primary.get("rolloutStateReason") or "no reason given"))
elif len(deployments) != 1 or state != "COMPLETED":
    print("pending {} deployment(s), the PRIMARY one {}".format(len(deployments), state))
elif [entry.get("desiredCount"), entry.get("runningCount"), entry.get("pendingCount")] != [int(env["FSS_DESIRED"]), int(env["FSS_DESIRED"]), 0]:
    print("failed its COMPLETED rollout runs {} of {} task(s) with {} pending, and {} are declared".format(
        entry.get("runningCount"), entry.get("desiredCount"), entry.get("pendingCount"), env["FSS_DESIRED"]))
else:
    print("completed")
PY
)"
    case "$verdict" in
      completed)
        rehearsal_log "$name: its rollout to $revision is COMPLETED, $desired task(s) running and none pending"
        return 0
        ;;
      failed\ *)
        echo "FAIL: $name: ${verdict#failed }" >&2
        return 1
        ;;
    esac
    rehearsal_log "$name: ${verdict#pending }; reading it again (read $attempt of $CI_ROLLOUT_READS)"
    [ "$attempt" -eq "$CI_ROLLOUT_READS" ] || sleep "$CI_ROLLOUT_SECONDS"
  done
  echo "FAIL: $name's rollout to $revision is not COMPLETED after $CI_ROLLOUT_READS reads: ${verdict#pending }" >&2
  return 1
}

# The revision a service names now, as ECS reports it.
ci_observed() {
  release_aws "$CI_ENVIRONMENT" ecs describe-services --cluster "$CLUSTER_ARN" --services "${CI_PREFIX}-$1" --output json 2>/dev/null \
    | python3 -c '
import json, sys
services = (json.load(sys.stdin) or {}).get("services") or []
print(services[0].get("taskDefinition", "") if services else "")
' 2>/dev/null || true
}

ci_deregister() { # ci_deregister <revision> <why>
  if release_aws "$CI_ENVIRONMENT" ecs deregister-task-definition --task-definition "$1" --output json >/dev/null; then
    rehearsal_log "deregistered $1: $2"
  else
    echo "FAIL: could not deregister $1 ($2). It is the newest ACTIVE revision of its family, which Terraform reads; deregister it with the admin profile before the next production plan." >&2
  fi
}

# ===========================================================================
DEPLOY_SUBCOMMAND=${1:-}
shift || true
case "$DEPLOY_SUBCOMMAND" in
  release) deploy_release "$@" ;;
  bootstrap) deploy_bootstrap "$@" ;;
  current) deploy_current "$@" ;;
  ci) deploy_ci "$@" ;;
  *) deploy_usage 2 ;;
esac
