#!/usr/bin/env bash
# The images and schema ranges an environment's two services run now (lane g91).
#
#   infra/scripts/deployed-digests.sh fss-prod
#   infra/scripts/deployed-digests.sh fss-prod --var-flags     # the same, as -var= flags
#   infra/scripts/deployed-digests.sh fss-prod --compare <api_image> <worker_image> [--allow-digest-change]
#
# prints
#
#   api_image=<registry>/fss-prod-api@sha256:…
#   worker_image=<registry>/fss-prod-worker@sha256:…
#   api_schema_range={min=16,max=16}
#   worker_schema_range={min=16,max=16}
#
# ## Why an operator's plan starts here
#
# App-only changes reach production through `.github/workflows/greenfield-deploy.yml`,
# which registers the next revision of each service's task definition with a new image
# and runs no Terraform. So the digests in the last plan somebody applied are not the
# digests production runs, and `api_image`/`worker_image` are required variables of
# `infra/roots/production`. The two service task definitions track the newest revision
# of their family (`track_latest`, `infra/modules/cluster`), which makes a plan given
# *these* values a plan with no change to either definition or either service. A plan
# given the values from an older release would register the older images and roll the
# services back to them. That is the drift rule of `docs/greenfield/release.md` 4.0:
#
#   * an infrastructure change: plan with exactly what this prints;
#   * a schema release: plan with the release's own digests and ranges, which this
#     prints the current values beside, so the plan's image diff reads as intended.
#
#   (cd infra/roots/production && terraform plan -out=production.tfplan \
#      $(../../scripts/deployed-digests.sh fss-prod --var-flags) \
#      -var="certificate_arn=…" -var="api_hostname=api.usecallie.com" …)
#
# `--compare` is the check immediately before `terraform apply production.tfplan`: give
# it the two images the saved plan was made with, and it exits 1 when either is not the
# image its service runs now — a CI deploy landed between the plan and the apply, and the
# plan would roll production back. A schema release plans with its own new images on
# purpose, and says so with `--allow-digest-change`.
#
# Three refusals, all exit 1. A service whose rollout is not finished, because "what it
# runs" has two answers then: it must have one PRIMARY deployment that ECS calls
# COMPLETED, its declared count running and nothing pending, and every RUNNING task of
# the service must be of that deployment's revision and report its image digest
# (lane A1; `release_require_running_digest`, the check the deploy holds every rollout
# to). One deployment is not enough: ECS reports a lone PRIMARY deployment IN_PROGRESS
# with nothing running yet. A service stopped for a schema release (desired zero, as
# `release-stop.sh` leaves it) runs no task, and what it would run is its revision's.
# Then a family whose newest ACTIVE revision is not the one its service runs:
# `track_latest` makes Terraform read the newest, so a plan would be made against a
# revision nothing runs. A CI deploy deregisters the revision of a rollout ECS rolled
# back, so this is a failure somebody must look at; the message names the revision and
# the command that reconciles it.
#
# Read-only: describe-services, describe-task-definition, list-tasks and describe-tasks,
# with the operator's own credentials. What the task read prints goes to stderr, so
# stdout stays the four lines a plan is given.
#
# Offline seams: FSS_REHEARSAL_AWS_COMMAND (the AWS CLI) and FSS_RELEASE_ACCOUNT.

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

PREFIX=${1:-}
shift || true
FORM=''
COMPARE_API=''
COMPARE_WORKER=''
ALLOW_DIGEST_CHANGE=0
usage() {
  echo "usage: $(basename "$0") <prefix> [--var-flags] [--compare <api_image> <worker_image> [--allow-digest-change]]" >&2
  exit 2
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --var-flags) FORM=--var-flags; shift ;;
    --compare)
      [ "$#" -ge 3 ] || usage
      COMPARE_API=$2
      COMPARE_WORKER=$3
      shift 3
      ;;
    --allow-digest-change) ALLOW_DIGEST_CHANGE=1; shift ;;
    *) usage ;;
  esac
done
if [ "$ALLOW_DIGEST_CHANGE" = 1 ] && [ -z "$COMPARE_API" ]; then usage; fi
ENVIRONMENT="$(release_environment_for_prefix "$PREFIX")" || exit 2
if rehearsal_dry_run; then
  echo "FAIL: deployed-digests.sh only reads, and what it reads is the answer; there is nothing to dry-run" >&2
  exit 2
fi

ACCOUNT="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
REGION=${AWS_REGION:-us-east-1}
CLUSTER_ARN="arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${PREFIX}-cluster"
release_require_arn "the cluster" "$CLUSTER_ARN" ecs "$ACCOUNT" "$REGION" "$PREFIX" || exit 1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-deployed.XXXXXX")"
# shellcheck disable=SC2064 # the path is fixed now
trap "rm -rf '$WORK'" EXIT

LINES=''
for service in api worker; do
  name="${PREFIX}-$service"
  release_aws "$ENVIRONMENT" ecs describe-services --cluster "$CLUSTER_ARN" --services "$name" --output json \
    >"$WORK/service.json" || exit 1
  running="$(FSS_FILE="$WORK/service.json" FSS_NAME="$name" python3 - <<'PY'
# deployed-digests-service
import json, os, sys
name = os.environ["FSS_NAME"]
entry = next((s for s in (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("services") or []
              if s.get("serviceName") == name), None)
if entry is None or entry.get("status") != "ACTIVE":
    sys.exit("FAIL: ECS does not describe {} as an ACTIVE service".format(name))
deployments = entry.get("deployments") or []
if len(deployments) != 1:
    sys.exit("FAIL: {} has {} deployments: a rollout is under way. Read the digests when it has finished.".format(name, len(deployments)))
deployment = deployments[0]
if deployment.get("status") != "PRIMARY" or deployment.get("rolloutState") != "COMPLETED":
    sys.exit("FAIL: {}'s one deployment is {} with its rollout {}: a rollout is under way. Read the digests when it has finished.".format(
        name, deployment.get("status"), deployment.get("rolloutState")))
if not deployment.get("taskDefinition") or deployment.get("taskDefinition") != entry.get("taskDefinition"):
    sys.exit("FAIL: {}'s deployment runs {} and the service names {}".format(name, deployment.get("taskDefinition"), entry.get("taskDefinition")))
counts = [entry.get(field) for field in ("desiredCount", "runningCount", "pendingCount")]
if any(not isinstance(count, int) for count in counts):
    sys.exit("FAIL: ECS did not report all three counts for {}".format(name))
desired, running, pending = counts
if running != desired or pending != 0:
    sys.exit("FAIL: {} runs {} of {} task(s) with {} pending: a rollout is under way, or an outage. Read the digests when it has finished.".format(
        name, running, desired, pending))
print(entry["taskDefinition"], desired)
PY
)" || exit 1
  read -r running desired <<<"$running"
  release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$running" --output json \
    >"$WORK/definition.json" || exit 1
  release_aws "$ENVIRONMENT" ecs describe-task-definition --task-definition "$name" --output json \
    >"$WORK/latest.json" || exit 1
  line="$(FSS_DEFINITION="$WORK/definition.json" FSS_LATEST="$WORK/latest.json" FSS_NAME="$name" \
    FSS_SERVICE="$service" FSS_RUNNING="$running" python3 - <<'PY'
# deployed-digests-definition
import json, os, re, sys
env = os.environ
name, service = env["FSS_NAME"], env["FSS_SERVICE"]
definition = (json.load(open(env["FSS_DEFINITION"], encoding="utf-8")) or {}).get("taskDefinition") or {}
latest = (json.load(open(env["FSS_LATEST"], encoding="utf-8")) or {}).get("taskDefinition") or {}
container = next((c for c in definition.get("containerDefinitions") or [] if c.get("name") == service), None)
if container is None:
    sys.exit("FAIL: {} has no container named {}".format(env["FSS_RUNNING"], service))
image = container.get("image", "")
if not re.fullmatch(r"[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/" + re.escape(name) + r"@sha256:[0-9a-f]{64}", image):
    sys.exit("FAIL: {} runs '{}', which is not an image of {} by digest".format(name, image, name))
environment = {item.get("name"): item.get("value") for item in container.get("environment") or []}
try:
    minimum, maximum = int(environment["FSS_SCHEMA_MIN"]), int(environment["FSS_SCHEMA_MAX"])
except (KeyError, TypeError, ValueError):
    sys.exit("FAIL: {} declares no schema range".format(env["FSS_RUNNING"]))
if latest.get("taskDefinitionArn") and latest["taskDefinitionArn"] != env["FSS_RUNNING"]:
    sys.exit("FAIL: {} runs {}, and its family's newest ACTIVE revision is {}. Terraform reads the newest "
             "(track_latest), so a plan now is made against a revision nothing runs. Reconcile first: if {} "
             "is a rolled-back deploy, aws ecs deregister-task-definition --task-definition {} with the admin "
             "profile, then run this again.".format(
                 name, env["FSS_RUNNING"], latest["taskDefinitionArn"], latest["taskDefinitionArn"], latest["taskDefinitionArn"]))
print("{}_image={} {}_schema_range={{min={},max={}}}".format(service, image, service, minimum, maximum))
PY
)" || exit 1
  # Every RUNNING task of the service, read and held to that image's digest: exactly the
  # declared count, each of the deployment's revision. What it prints goes to stderr.
  image="${line%% *}"
  image="${image#*=}"
  release_require_running_digest "$ENVIRONMENT" "$CLUSTER_ARN" "$name" "$service" "${image##*@}" "$desired" >&2 \
    || { echo "FAIL: $name's running tasks are not all $image; read the digests when its rollout has finished" >&2; exit 1; }
  LINES="$LINES $line"
done

if [ -n "$COMPARE_API" ]; then
  differs=''
  for pair in $LINES; do
    case "$pair" in
      api_image=*) [ "${pair#api_image=}" = "$COMPARE_API" ] || differs="$differs api (runs ${pair#api_image=}, the plan has $COMPARE_API)" ;;
      worker_image=*) [ "${pair#worker_image=}" = "$COMPARE_WORKER" ] || differs="$differs worker (runs ${pair#worker_image=}, the plan has $COMPARE_WORKER)" ;;
    esac
  done
  if [ -n "$differs" ]; then
    if [ "$ALLOW_DIGEST_CHANGE" = 1 ]; then
      echo "the plan changes the image of:$differs, and --allow-digest-change says that is this release" >&2
    else
      echo "FAIL: the plan's images are not the ones production runs:$differs. Applying it would put other images on the services; plan again from this script's output, or pass --allow-digest-change for a release that changes them on purpose." >&2
      exit 1
    fi
  else
    echo "the plan's two images are the ones production runs" >&2
  fi
fi

# Images first, then ranges, one per line.
for key in api_image worker_image api_schema_range worker_schema_range; do
  for pair in $LINES; do
    case "$pair" in
      "$key="*)
        if [ "$FORM" = --var-flags ]; then printf -- '-var=%s\n' "$pair"; else printf '%s\n' "$pair"; fi
        ;;
    esac
  done
done
