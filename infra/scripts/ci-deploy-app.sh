#!/usr/bin/env bash
# An app-only change, deployed to production by CI (lane g91).
#
#   infra/scripts/ci-deploy-app.sh check  --digests <image-digests.json> --commit <sha> \
#       --run-id <id> --run-attempt <n> --run-started <instant> --run-ended <instant> \
#       --api-range <min>-<max> --worker-range <min>-<max> --origin https://api.usecallie.com
#   infra/scripts/ci-deploy-app.sh deploy --digests <image-digests.json> --commit <sha> \
#       --run-id <id> --run-attempt <n> --run-started <instant> --run-ended <instant> \
#       --api-range <min>-<max> --worker-range <min>-<max>
#   infra/scripts/ci-deploy-app.sh record --before-rollout|--after-rollout \
#       --digests <image-digests.json> --commit <sha> \
#       --run-id <id> --run-attempt <n> --run-started <instant> --run-ended <instant> \
#       --api-range <min>-<max> --worker-range <min>-<max> \
#       --gate-run-id <id> --cluster-name <name> --operations-family <family> \
#       --subnets <subnet-a,subnet-b> --security-group <sg-id>
#
# `--run-started` and `--run-ended` are the images run's `created_at` and `updated_at`
# (`YYYY-MM-DDTHH:MM:SSZ`), which the workflow's `run` job read from the GitHub API: the
# window the run's own push of `fss-rh-<image>:ci-<commit>` must fall in (lane A1).
#
# David's decision of 25 September 2026: "I'm a startup, I want to move fast." A merge
# to main that changes only application code reaches production with nobody in the
# loop; a schema or infrastructure change keeps the manual path (`docs/greenfield/
# release.md` section 4). `.github/workflows/greenfield-deploy.yml` runs this, as the
# role `fss-prod-ci-deploy` (`infra/roots/production/ci_deploy.tf`), and only after
# its own inline guard has found no protected path in any commit between the one
# production's images were built from and the images commit. That guard is the path
# classification; this file never decides which paths are application code, because a
# script under `infra/scripts/` is itself a protected path and must not be the thing
# that vouches for its own change. The order is:
#
#   the gate (workflow)   the Greenfield gate (greenfield.yml) green on the images
#                         commit, by workflow file, and the commit still on main;
#                         read before the role is assumed and again before the first
#                         write (lane A1);
#   the guard (workflow)  every commit since production's, one by one: manual, or pass;
#   check                 every read and every other guard, and nothing that writes;
#   the gate again (workflow), then
#   record --before-rollout  the ci-gate release record for the two digests, built by
#                         `release-record-from-ci.sh` from the green gate run on the
#                         images commit and put with `fss admin release-record put` on
#                         the operations task — the first write, so the record exists
#                         before any new worker task can claim a send;
#   release-promote.sh    the two digests copied into fss-prod-*, by digest (--app-only);
#   deploy                a new revision of each service's running task definition with
#                         only the image digest changed, verified against the running one
#                         after ECS registered it; the worker rolled, waited on and held
#                         to its digest; only then the API, the same way;
#   the production smoke  in a job of its own, which holds no credential;
#   record --after-rollout  in a job of its own: the same record put again, which must
#                         answer `existing` now that production runs its digests — the
#                         read-back that the deployment running has its record, so a worker
#                         under the owner's process attestation (`ci-gate:main`) sends.
#
# No Terraform, and nothing here runs code from the images commit: the schema ranges
# arrive as two validated scalars. The task definitions CI registers are the next
# revisions of the running ones, so nothing but the image moves, and Terraform reads
# them back as its own (`track_latest` in `infra/modules/cluster`).
#
# ## check: the decision
#
# `decision=deploy`, `decision=current` (production already runs these digests) or
# `decision=manual` with a `reason`, written to `$GITHUB_OUTPUT` and printed. A manual
# decision exits 0; an error exits 1. The manual answers:
#
#   * **The images expect a different schema.** Both binaries refuse to start unless
#     `FSS_SCHEMA_MIN`/`MAX` in their task definition equal the range compiled into them,
#     and a CI revision changes only the image. So the images' ranges must equal both
#     running task definitions' ranges, and the running API's `/health` must declare the
#     same range, accept its schema, and report a database version inside both images'.
#   * **A service is not running at its declared count.** Desired zero is a schema
#     release in progress (`release-stop.sh`); running short of desired, or anything
#     pending, is an outage or a rollout nobody finished. Either is the operator's.
#
# The errors: a session that is not exactly `fss-prod-ci-deploy` in the production
# account and region, a cluster tagged as another environment, a service mid-rollout,
# a digests file that does not belong to the images run, a digest that is not the one
# `fss-rh-<image>:ci-<commit>` names, an image under that tag pushed outside the images
# run's window, or a production that does not answer `/health`.
#
# ## Provenance, and what it does not cover (lane A1)
#
# The workflow downloads the digests file from the images run's own artifact, found
# through that run and held to the digest GitHub recorded for it, and this script holds
# the file to the run's id and attempt. Each digest must be the one the rehearsal
# repository holds under `ci-<commit>`, and that image's `imagePushedAt` must fall
# inside the images run's window, from its creation to its last update. So an image
# pushed under the tag before the run began, or after it ended, is refused. What is
# left is another writer to `fss-rh-*` — only `fss-rh-deploy` can write there — pushing
# the tag while the run is going, and that is accepted (release.md 4.0).
#
# ## deploy: what a failure leaves behind
#
# Every read and guard of `check` is repeated first, so a production that changed in
# between is not written to. The worker goes first and is held to its digest before the
# API is touched: stable, then its one deployment COMPLETED as ECS calls it with the
# declared count running and nothing pending, then every RUNNING task read with
# `list-tasks` and `describe-tasks` and holding the new digest (lane A1). Each registered revision is described back and compared with the
# running one field by field; anything but the image different, and it is deregistered
# before any service names it. Each service keeps the deployment circuit breaker with
# rollback: a revision whose tasks fail is rolled back by ECS, and when the service is
# observed back on its previous revision the new one is deregistered, so the newest
# ACTIVE revision — the one Terraform reads — is the one that runs. The stopped tasks'
# stop codes, exit codes and the `event`, `reason` and `code` of their structured log
# lines are printed, and nothing else from an application log. Nothing here changes a
# count.
#
# ## record: the release record, before the rollout and read back after it
#
# The worker admits a send only when a stored record names its own digest. Until
# 26 September 2026 the record was put after the smoke (lane g100), so every new worker
# task that started during the rollout found none, and a step due then was refused
# `release_record_unknown` and waited up to an hour. So:
#
#   * `record --before-rollout` runs in the deploy job, after `check` decided `deploy` and
#     the gate was read again, and before the promotion: the first write. Production
#     still runs the previous digests, and that is expected. A record for a rollout that
#     then fails is inert: no running process has its digests.
#   * `record --after-rollout` runs after the smoke. It refuses unless both services run
#     exactly the two digests, puts the same record again, and requires `existing`: the
#     read-back that the deployment now running has its record.
#
# Both repeat every read and guard of `check` first. The
# record is `release-record-from-ci.sh <gate run id> <commit> <api> <worker>`, which
# reads GitHub only and refuses unless the gate run is a green push to main at the
# commit and the images run published these two digests. It is put on the operations
# task the way `release-deploy.sh --release-record` puts one, through
# `release_run_task`, and the task's answer is read back from its log. What that needs
# and the role holds (`infra/roots/production/ci_deploy.tf`): `ecs:RunTask` of the
# operations family in the production cluster, the worker's two roles, the worker's log
# group.
#
# The operations definition is Terraform's and does not track: it carries the worker
# image of the last apply, not this deploy's (release.md 4.0). That image puts the
# record; the record names this deploy's digests, and each process compares its own
# half. So the digest the wrapper holds the task to is the definition's own, which must
# be an `fss-prod-worker` image by digest, under the worker's roles and log group.
#
# The cluster, the family, the subnets and the security group are public identifiers the
# workflow passes from repository variables, set from the production root's
# `ci_deploy_*` outputs; nothing here reads Terraform state. The cluster name must be the
# one this script acts on, so a variable that drifted from the root is a refusal.
#
# Offline seams, for `test/ops/ciDeploy.check.ts`: FSS_REHEARSAL_AWS_COMMAND (the AWS
# CLI), FSS_CI_CALLER_IDENTITY (the session ARN), FSS_CI_HEALTH_JSON (the `/health`
# body), FSS_CI_WAIT_ATTEMPTS, FSS_CI_ROLLOUT_READS and FSS_CI_ROLLOUT_SECONDS, and for
# `record` FSS_GH_COMMAND (the `gh`
# `release-record-from-ci.sh` asks). There is no dry run: every step before `deploy` is a
# read, and the offline check drives the whole script against a stub CLI instead.

CI_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$CI_SCRIPTS/lib.sh"

CI_PREFIX="$RELEASE_PRODUCTION_PREFIX"
CI_ENVIRONMENT=production
CI_ROLE="${CI_PREFIX}-ci-deploy"
# The production account and region; the workflow sets neither, so the defaults hold.
CI_ACCOUNT="${FSS_PRODUCTION_ACCOUNT_ID:-326255650484}"
CI_REGION="${FSS_PRODUCTION_REGION:-us-east-1}"
# The order the services roll in. The worker first, as on every path in release-deploy.sh.
CI_SERVICES='worker api'
# Three of the CLI's ten-minute waits per service; the workflow's timeout is twice both.
CI_WAIT_ATTEMPTS="${FSS_CI_WAIT_ATTEMPTS:-3}"
# After the waiter, up to five minutes for ECS to call the rollout COMPLETED (lane A1).
CI_ROLLOUT_READS="${FSS_CI_ROLLOUT_READS:-20}"
CI_ROLLOUT_SECONDS="${FSS_CI_ROLLOUT_SECONDS:-15}"

ci_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# One line per key, in `$GITHUB_OUTPUT` when the workflow gave one, and on stdout.
ci_output() {
  local key=$1 value=${2//$'\n'/ }
  printf '%s=%s\n' "$key" "$value"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

# The end of `check`: a decision, a reason, exit 0.
ci_decide() {
  local decision=$1 reason=$2
  ci_output decision "$decision"
  ci_output reason "$reason"
  if [ "$decision" = manual ]; then
    echo "::notice title=Not deployed by CI; the manual path applies::$reason"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  check | deploy | record) ;;
  *)
    echo "usage: $(basename "$0") <check|deploy|record> --digests <image-digests.json> --commit <sha> --run-id <id> --run-attempt <n> --run-started <instant> --run-ended <instant> --api-range <min>-<max> --worker-range <min>-<max> [--origin <https url>] [--before-rollout|--after-rollout --gate-run-id <id> --cluster-name <name> --operations-family <family> --subnets <ids> --security-group <id>]" >&2
    exit 2
    ;;
esac

DIGESTS=''
COMMIT=''
RUN_ID=''
RUN_ATTEMPT=''
RUN_STARTED=''
RUN_ENDED=''
API_RANGE=''
WORKER_RANGE=''
ORIGIN=''
GATE_RUN_ID=''
RECORD_CLUSTER_NAME=''
OPERATIONS_FAMILY=''
TASK_SUBNETS=''
TASK_SECURITY_GROUP=''
RECORD_STAGE=''
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
    *) ci_fail "ci-deploy-app.sh does not take '$1'" ;;
  esac
done

if rehearsal_dry_run; then
  ci_fail "ci-deploy-app.sh has no dry run. Every step of check is a read, and test/ops/ciDeploy.check.ts drives the whole script against a stub CLI."
fi
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || ci_fail "--commit '$COMMIT' is not a full forty-character commit"
[[ "$RUN_ID" =~ ^[0-9]{1,20}$ ]] || ci_fail "--run-id '$RUN_ID' is not a workflow run id"
[[ "$RUN_ATTEMPT" =~ ^[0-9]{1,4}$ ]] || ci_fail "--run-attempt '$RUN_ATTEMPT' is not a run attempt"
for instant in "$RUN_STARTED" "$RUN_ENDED"; do
  [[ "$instant" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] \
    || ci_fail "'$instant' is not a UTC instant; pass the images run's created_at and updated_at as --run-started and --run-ended"
done
[[ ! "$RUN_ENDED" < "$RUN_STARTED" ]] || ci_fail "the images run ended at $RUN_ENDED, before it started at $RUN_STARTED"
for range in "$API_RANGE" "$WORKER_RANGE"; do
  [[ "$range" =~ ^[0-9]{1,4}-[0-9]{1,4}$ ]] || ci_fail "'$range' is not a schema range; pass <min>-<max>"
done
if [ "$SUBCOMMAND" = check ]; then
  [[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || ci_fail "--origin '$ORIGIN' is not an https origin; production has no port-80 listener"
fi
if [ "$SUBCOMMAND" = record ]; then
  [ -n "$RECORD_STAGE" ] \
    || ci_fail "record needs --before-rollout (the deploy job's put, before its first write) or --after-rollout (the read-back after the smoke)"
elif [ -n "$RECORD_STAGE" ]; then
  ci_fail "--before-rollout and --after-rollout belong to record, not to $SUBCOMMAND"
fi
if [ "$SUBCOMMAND" = record ]; then
  # Five public identifiers, each judged before anything is asked. The last four come
  # from repository variables (release.md 4.0); an empty one is a variable nobody set.
  [[ "$GATE_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]] || ci_fail "--gate-run-id '$GATE_RUN_ID' is not a GitHub Actions run id"
  [[ "$RECORD_CLUSTER_NAME" =~ ^${CI_PREFIX}-[a-z0-9-]{1,40}$ ]] \
    || ci_fail "--cluster-name '$RECORD_CLUSTER_NAME' is not a ${CI_PREFIX} cluster name; set the repository variable FSS_PRODUCTION_CLUSTER_NAME (release.md 4.0)"
  [[ "$OPERATIONS_FAMILY" =~ ^${CI_PREFIX}-[a-z0-9-]{1,40}$ ]] \
    || ci_fail "--operations-family '$OPERATIONS_FAMILY' is not a ${CI_PREFIX} task definition family; set the repository variable FSS_PRODUCTION_OPERATIONS_TASK_FAMILY (release.md 4.0)"
  [[ "$TASK_SUBNETS" =~ ^subnet-[0-9a-f]{8,17}(,subnet-[0-9a-f]{8,17}){0,5}$ ]] \
    || ci_fail "--subnets '$TASK_SUBNETS' is not a comma-separated list of subnet ids; set the repository variable FSS_PRODUCTION_TASK_SUBNET_IDS (release.md 4.0)"
  [[ "$TASK_SECURITY_GROUP" =~ ^sg-[0-9a-f]{8,17}$ ]] \
    || ci_fail "--security-group '$TASK_SECURITY_GROUP' is not a security group id; set the repository variable FSS_PRODUCTION_TASK_SECURITY_GROUP_ID (release.md 4.0)"
fi

# The digests file the images run's publish job wrote, for exactly this commit and run.
read -r API_DIGEST WORKER_DIGEST <<<"$(FSS_FILE="$DIGESTS" FSS_COMMIT="$COMMIT" FSS_RUN_ID="$RUN_ID" FSS_RUN_ATTEMPT="$RUN_ATTEMPT" python3 - <<'PY'
# ci-deploy-read-digests
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

CI_WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-ci-deploy.XXXXXX")"
# shellcheck disable=SC2064 # the path is fixed now
trap "rm -rf '$CI_WORK'" EXIT

# ---------------------------------------------------------------------------
# The session: exactly the CI role, in the production account and region.
# ---------------------------------------------------------------------------
[[ "$CI_ACCOUNT" =~ ^[0-9]{12}$ ]] || ci_fail "the production account '$CI_ACCOUNT' is not an account id"
REGION=${AWS_REGION:-$CI_REGION}
[ "$REGION" = "$CI_REGION" ] || ci_fail "the session is configured for $REGION, and production is in $CI_REGION"
if [ "${FSS_CI_CALLER_IDENTITY+set}" = "set" ]; then
  IDENTITY=$FSS_CI_CALLER_IDENTITY
else
  IDENTITY="$(command "$(rehearsal_aws_command)" sts get-caller-identity --query Arn --output text)" \
    || ci_fail "the session could not be identified"
fi
echo "caller identity: ${IDENTITY:-<none>}"
if [[ ! "$IDENTITY" =~ ^arn:aws:sts::${CI_ACCOUNT}:assumed-role/${CI_ROLE}/[A-Za-z0-9+=,.@_-]+$ ]]; then
  ci_fail "this session is ${IDENTITY:-<none>}, which is not an assumed-role session of arn:aws:iam::${CI_ACCOUNT}:role/${CI_ROLE}. The CI deploy acts as that role in the production account and nothing else; an operator deploys with release-deploy.sh."
fi
ACCOUNT=$CI_ACCOUNT
CLUSTER_ARN="arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CI_PREFIX}-cluster"
release_require_arn "the cluster" "$CLUSTER_ARN" ecs "$ACCOUNT" "$REGION" "$CI_PREFIX" || exit 1
CLUSTER_TAG="$(release_cluster_environment_tag "$CI_ENVIRONMENT" "$CLUSTER_ARN")"
[ "$CLUSTER_TAG" = production ] \
  || ci_fail "the cluster is tagged Environment=${CLUSTER_TAG:-<none>}, and this is the production deploy"
rehearsal_log "cluster $CLUSTER_ARN, tagged Environment=production"

# ---------------------------------------------------------------------------
# Provenance: the digests are the ones the rehearsal repositories hold under
# ci-<commit>, and each was pushed while the images run was going (lane A1). The tags
# are immutable, so the image under one is the first one pushed there.
# ---------------------------------------------------------------------------
for service in $CI_SERVICES; do
  expected=$API_DIGEST
  [ "$service" = worker ] && expected=$WORKER_DIGEST
  # A read of a rehearsal repository, which `release_aws` refuses in a production command
  # by design; so the CLI directly, with the two literal names and nothing else.
  case "$service" in api | worker) ;; *) ci_fail "'$service' is not a service" ;; esac
  command "$(rehearsal_aws_command)" ecr describe-images --repository-name "fss-rh-$service" --image-ids "imageTag=ci-$COMMIT" \
    --output json >"$CI_WORK/$service-source.json" || ci_fail "ECR has no fss-rh-$service:ci-$COMMIT"
  read -r held pushed <<<"$(FSS_FILE="$CI_WORK/$service-source.json" python3 -c '
import json, os
details = (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("imageDetails") or []
detail = details[0] if len(details) == 1 else {}
print(detail.get("imageDigest") or "-", str(detail.get("imagePushedAt") or "-").replace(" ", "T"))
')"
  [ "$held" = "$expected" ] \
    || ci_fail "fss-rh-$service:ci-$COMMIT is ${held:-<nothing>}, and the digests file says $expected: the artifact does not name the image its run published"
  # When it was pushed, against the images run's window: the CLI prints an ISO instant
  # with an offset (v2) or seconds since the epoch (v1), and both are read.
  FSS_PUSHED="$pushed" FSS_STARTED="$RUN_STARTED" FSS_ENDED="$RUN_ENDED" FSS_IMAGE="fss-rh-$service:ci-$COMMIT" python3 - <<'PY' \
    || ci_fail "fss-rh-$service:ci-$COMMIT is not an image the images run $RUN_ID pushed"
# ci-deploy-pushed-within-run
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

# ---------------------------------------------------------------------------
# What each service runs now.
# ---------------------------------------------------------------------------

# ci_read_service <api|worker>: what the service runs, as $CI_WORK/<service>.json.
# Returns 3 for a service stopped for a schema release, 4 for one not at its declared
# count; both are the operator's.
ci_read_service() {
  local service=$1 name="${CI_PREFIX}-$1" arn status
  release_aws "$CI_ENVIRONMENT" ecs describe-services --cluster "$CLUSTER_ARN" --services "$name" --output json \
    >"$CI_WORK/$service-service.json" || ci_fail "ECS did not describe $name"
  set +e
  arn="$(FSS_FILE="$CI_WORK/$service-service.json" FSS_NAME="$name" python3 - <<'PY'
# ci-deploy-read-service
import json, os, sys
name = os.environ["FSS_NAME"]
answer = json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}
entry = next((s for s in answer.get("services") or [] if s.get("serviceName") == name), None)
if entry is None or entry.get("status") != "ACTIVE":
    print("FAIL: ECS does not describe {} as an ACTIVE service".format(name), file=sys.stderr)
    sys.exit(1)
deployments = entry.get("deployments") or []
if len(deployments) != 1 or deployments[0].get("status") != "PRIMARY":
    print("FAIL: {} has {} deployments: a rollout is under way. Nothing is deployed over one.".format(name, len(deployments)), file=sys.stderr)
    sys.exit(1)
if deployments[0].get("rolloutState") in ("IN_PROGRESS", "FAILED"):
    print("FAIL: {}'s deployment is {}".format(name, deployments[0].get("rolloutState")), file=sys.stderr)
    sys.exit(1)
if deployments[0].get("taskDefinition") != entry.get("taskDefinition"):
    print("FAIL: {}'s deployment runs {} and the service names {}".format(name, deployments[0].get("taskDefinition"), entry.get("taskDefinition")), file=sys.stderr)
    sys.exit(1)
counts = [entry.get(field) for field in ("desiredCount", "runningCount", "pendingCount")]
if any(not isinstance(count, int) for count in counts):
    print("FAIL: ECS did not report all three counts for {}".format(name), file=sys.stderr)
    sys.exit(1)
desired, running, pending = counts
print(entry["taskDefinition"], desired, running, pending)
if desired == 0:
    sys.exit(3)
if running != desired or pending != 0:
    sys.exit(4)
PY
)"
  status=$?
  set -e
  [ "$status" -eq 0 ] || [ "$status" -eq 3 ] || [ "$status" -eq 4 ] || exit 1
  read -r arn CI_DESIRED CI_RUNNING CI_PENDING <<<"$arn"
  [ "$status" -eq 0 ] || return "$status"
  release_aws "$CI_ENVIRONMENT" ecs describe-task-definition --task-definition "$arn" --include TAGS --output json \
    >"$CI_WORK/$service-definition.json" || ci_fail "ECS did not describe $arn"
  FSS_SERVICE="$service" FSS_NAME="$name" FSS_WORK="$CI_WORK" FSS_ACCOUNT="$ACCOUNT" FSS_REGION="$REGION" \
    FSS_PREFIX="$CI_PREFIX" python3 - <<'PY' || exit 1
# ci-deploy-read-definition
import json, os, re, sys
env = os.environ
service, name, work = env["FSS_SERVICE"], env["FSS_NAME"], env["FSS_WORK"]

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

described = json.load(open(os.path.join(work, service + "-service.json"), encoding="utf-8"))
entry = next(s for s in described["services"] if s.get("serviceName") == name)
document = json.load(open(os.path.join(work, service + "-definition.json"), encoding="utf-8"))
definition = document.get("taskDefinition") or {}
if definition.get("family") != name:
    fail("{} runs a definition of family {}, not {}".format(name, definition.get("family"), name))
containers = definition.get("containerDefinitions") or []
if len(containers) != 1 or containers[0].get("name") != service:
    fail("{}'s definition must have exactly one container, named {}".format(name, service))
image = containers[0].get("image", "")
match = re.fullmatch(r"([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com/([a-z0-9-]+)@(sha256:[0-9a-f]{64})", image)
if not match:
    fail("{} runs '{}', which is not an ECR image by digest".format(name, image))
if match.group(3) != name or match.group(1) != env["FSS_ACCOUNT"] or match.group(2) != env["FSS_REGION"]:
    fail("{} runs an image from {}, not from {} in this account and region".format(name, image.split("@")[0], name))
environment = {item.get("name"): item.get("value") for item in containers[0].get("environment") or []}
try:
    minimum, maximum = int(environment["FSS_SCHEMA_MIN"]), int(environment["FSS_SCHEMA_MAX"])
except (KeyError, TypeError, ValueError):
    fail("{}'s definition declares no schema range".format(name))
tags = {tag.get("key"): tag.get("value") for tag in document.get("tags") or []}
if tags.get("NamePrefix") != env["FSS_PREFIX"]:
    fail("{}'s definition does not carry NamePrefix={}; a revision registered without it is refused by the role".format(name, env["FSS_PREFIX"]))
json.dump({
    "name": name,
    "taskDefinitionArn": definition.get("taskDefinitionArn") or entry["taskDefinition"],
    "revision": definition.get("revision"),
    "desired": entry["desiredCount"],
    "repository": image.split("@")[0],
    "digest": match.group(4),
    "schema": [minimum, maximum],
    "sendingEnabled": environment.get("FSS_SENDING_ENABLED"),
}, open(os.path.join(work, service + ".json"), "w", encoding="utf-8"))
PY
}

# ci_field <service> <field>
ci_field() {
  FSS_FILE="$CI_WORK/$1.json" FSS_FIELD="$2" python3 -c '
import json, os
value = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))[os.environ["FSS_FIELD"]]
print("-".join(str(part) for part in value) if isinstance(value, list) else value)
'
}

NOT_RUNNING=''
for service in $CI_SERVICES; do
  status=0
  ci_read_service "$service" || status=$?
  case "$status" in
    0) rehearsal_log "${CI_PREFIX}-$service runs $(ci_field "$service" taskDefinitionArn) ($(ci_field "$service" digest), schema $(ci_field "$service" schema), $(ci_field "$service" desired) task(s))" ;;
    3) NOT_RUNNING="$NOT_RUNNING; ${CI_PREFIX}-$service is at desired count zero, which is a schema release in progress" ;;
    4) NOT_RUNNING="$NOT_RUNNING; ${CI_PREFIX}-$service runs $CI_RUNNING of $CI_DESIRED task(s) with $CI_PENDING pending, which is an outage or an unfinished rollout" ;;
  esac
done
if [ -n "$NOT_RUNNING" ]; then
  reason="production is not running at its declared counts (${NOT_RUNNING#; }), and that is the operator's"
  [ "$SUBCOMMAND" = check ] && ci_decide manual "$reason"
  ci_fail "$reason"
fi

# The schema guard's first half, on both subcommands: the images' ranges against the
# ranges the running task definitions declare, which a CI revision keeps.
SCHEMA_MISMATCH=''
[ "$(ci_field api schema)" = "$API_RANGE" ] || SCHEMA_MISMATCH="api"
[ "$(ci_field worker schema)" = "$WORKER_RANGE" ] || SCHEMA_MISMATCH="${SCHEMA_MISMATCH:+$SCHEMA_MISMATCH and }worker"
if [ -n "$SCHEMA_MISMATCH" ]; then
  reason="the images declare schema api $API_RANGE and worker $WORKER_RANGE, and production's task definitions declare api $(ci_field api schema) and worker $(ci_field worker schema): a different schema range ($SCHEMA_MISMATCH) is a schema change"
  [ "$SUBCOMMAND" = check ] && ci_decide manual "$reason"
  ci_fail "$reason"
fi

ALREADY_RUNNING=0
if [ "$(ci_field api digest)" = "$API_DIGEST" ] && [ "$(ci_field worker digest)" = "$WORKER_DIGEST" ]; then
  ALREADY_RUNNING=1
fi

# ---------------------------------------------------------------------------
# record (lane g100)
# ---------------------------------------------------------------------------
if [ "$SUBCOMMAND" = record ]; then
  if [ "$RECORD_STAGE" = after ] && [ "$ALREADY_RUNNING" -ne 1 ]; then
    ci_fail "production runs api $(ci_field api digest) and worker $(ci_field worker digest), not the deployed api $API_DIGEST and worker $WORKER_DIGEST. The read-back after the rollout is for a deployment that runs its record's digests."
  fi
  if [ "$RECORD_STAGE" = before ] && [ "$ALREADY_RUNNING" -ne 1 ]; then
    rehearsal_log "before the rollout: production runs api $(ci_field api digest) and worker $(ci_field worker digest); the record for api $API_DIGEST and worker $WORKER_DIGEST is stored first, so no new worker task starts without one"
  fi
  [ "$RECORD_CLUSTER_NAME" = "${CI_PREFIX}-cluster" ] \
    || ci_fail "the repository variable FSS_PRODUCTION_CLUSTER_NAME names $RECORD_CLUSTER_NAME, and this deploy acts on ${CI_PREFIX}-cluster; set it again from terraform output -raw ci_deploy_cluster_name"

  # 1. The record: GitHub only, from the gate run that was green on the images commit.
  RECORD_REFERENCE="ci-gate-${GATE_RUN_ID}-${COMMIT:0:12}"
  "$CI_SCRIPTS/record.sh" from-ci "$GATE_RUN_ID" "$COMMIT" "$API_DIGEST" "$WORKER_DIGEST" \
    --out "$CI_WORK/release-record.json" \
    || ci_fail "record.sh from-ci wrote no record for gate run $GATE_RUN_ID; its FAIL line above says why"
  rehearsal_log "release record $RECORD_REFERENCE built from gate run $GATE_RUN_ID (api $API_DIGEST, worker $WORKER_DIGEST)"

  # 2. The operations definition as ECS holds it — the family's newest ACTIVE revision,
  # which is the one Terraform registered — judged against the worker's running one. The
  # session is already this account's and region's, and the answer's ARN is held to both.
  release_aws "$CI_ENVIRONMENT" ecs describe-task-definition --task-definition "$OPERATIONS_FAMILY" --output json \
    >"$CI_WORK/operations-definition.json" || ci_fail "ECS did not describe the task definition family $OPERATIONS_FAMILY"
  OPERATIONS_FACTS="$(FSS_OPERATIONS="$CI_WORK/operations-definition.json" FSS_WORKER="$CI_WORK/worker-definition.json" \
    FSS_FAMILY="$OPERATIONS_FAMILY" FSS_ACCOUNT="$ACCOUNT" FSS_REGION="$REGION" FSS_PREFIX="$CI_PREFIX" python3 - <<'PY'
# ci-deploy-read-operations
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
  read -r OPERATIONS_REVISION OPERATIONS_DIGEST OPERATIONS_LOG_GROUP RUNTIME_SECRET_ARN DATABASE_HOST <<<"$OPERATIONS_FACTS"
  [ "$DATABASE_HOST" != "-" ] || DATABASE_HOST=''
  rehearsal_log "the put runs $OPERATIONS_REVISION (${CI_PREFIX}-worker@$OPERATIONS_DIGEST, the image of the last apply); the record it stores names worker $WORKER_DIGEST"

  # 3. The put (lib.sh release_record_put, as record.sh runs it). The network is the one the repository
  # variables name; the worker group's zero inbound rules are what the production root's
  # isolation test holds it to.
  NETWORK_PLAN="$(FSS_SUBNETS="$TASK_SUBNETS" FSS_GROUP="$TASK_SECURITY_GROUP" python3 -c '
import json, os, sys
json.dump({"subnet_ids": os.environ["FSS_SUBNETS"].split(","), "security_group_id": os.environ["FSS_GROUP"],
           "assign_public_ip": "ENABLED", "inbound_rule_count": 0}, sys.stdout)
')"
  export FSS_REHEARSAL_REPORTS="${FSS_REHEARSAL_REPORTS:-$CI_WORK/reports}"
  release_record_put release-record-put "$CI_WORK/release-record.json" "$CI_ENVIRONMENT" "$CI_PREFIX" "$ACCOUNT" "$REGION" \
    "$CLUSTER_ARN" "$OPERATIONS_REVISION" "$OPERATIONS_DIGEST" "$NETWORK_PLAN" "$DATABASE_HOST" "$RUNTIME_SECRET_ARN" \
    "$OPERATIONS_LOG_GROUP" || exit 1
  RECORD_OUTCOME=$RELEASE_RECORD_OUTCOME
  if [ "$RECORD_STAGE" = after ] && [ "$RECORD_OUTCOME" != existing ]; then
    ci_fail "the read-back had to create the release record $RECORD_REFERENCE: it was not stored before the rollout, which the deploy job's put should have done. It is stored now."
  fi
  ci_output release_record_reference "$RECORD_REFERENCE"
  ci_output release_record_outcome "$RECORD_OUTCOME"
  rehearsal_log "release record $RECORD_REFERENCE stored ($RECORD_OUTCOME, ${RECORD_STAGE} the rollout): source ci-gate, api $API_DIGEST, worker $WORKER_DIGEST"
  exit 0
fi

# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------
if [ "$SUBCOMMAND" = check ]; then
  # The workflow's guard has already classified every commit since production's, so a
  # range with a protected path in it never reaches this line.
  if [ "$ALREADY_RUNNING" -eq 1 ]; then
    ci_decide current "production already runs api $API_DIGEST and worker $WORKER_DIGEST"
  fi

  # The schema guard's second half: what the running API says about itself.
  if [ "${FSS_CI_HEALTH_JSON+set}" = "set" ]; then
    printf '%s' "$FSS_CI_HEALTH_JSON" >"$CI_WORK/health.json"
  else
    curl -fsS --max-time 15 "$ORIGIN/health" >"$CI_WORK/health.json" \
      || ci_fail "$ORIGIN/health did not answer. A production that cannot report its schema is not one to deploy onto."
  fi
  set +e
  verdict="$(FSS_FILE="$CI_WORK/health.json" FSS_API="$API_RANGE" FSS_WORKER="$WORKER_RANGE" FSS_RUNNING="$(ci_field api schema)" python3 - <<'PY'
# ci-deploy-health
import json, os, sys
env = os.environ
try:
    body = json.load(open(env["FSS_FILE"], encoding="utf-8"))
    schema = body["schema"]
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
fi

# ---------------------------------------------------------------------------
# deploy
# ---------------------------------------------------------------------------

# The stopped tasks of a failed rollout: stop codes, exit codes, the log stream, and the
# `event`, `reason` and `code` fields of each structured log line — never a raw line.
# An application log can carry a value from an ECS-injected secret, and GitHub masks
# only the secrets it was given.
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

# Up to three of the CLI's ten-minute waits: the API drains its old targets for as long
# as the target group's deregistration delay, and a waiter that gives up is not a
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
# revision, COMPLETED, with the declared count running and nothing pending. The waiter
# and the task read say the tasks run the digest; a deployment still IN_PROGRESS can
# yet be rolled back by the circuit breaker, so it is read again until it is COMPLETED,
# FAILED or not this revision's, for at most CI_ROLLOUT_READS reads.
ci_rollout_completed() {
  local service=$1 name="${CI_PREFIX}-$1" revision=$2 desired=$3 attempt verdict
  for attempt in $(seq 1 "$CI_ROLLOUT_READS"); do
    release_aws "$CI_ENVIRONMENT" ecs describe-services --cluster "$CLUSTER_ARN" --services "$name" --output json \
      >"$CI_WORK/$service-rollout.json" || { echo "FAIL: ECS did not describe $name after its rollout" >&2; return 1; }
    verdict="$(FSS_FILE="$CI_WORK/$service-rollout.json" FSS_NAME="$name" FSS_REVISION="$revision" FSS_DESIRED="$desired" python3 - <<'PY'
# ci-deploy-rollout-completed
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

if [ "$ALREADY_RUNNING" -eq 1 ]; then
  rehearsal_log "production already runs api $API_DIGEST and worker $WORKER_DIGEST; nothing to register"
fi

for service in $CI_SERVICES; do
  name="${CI_PREFIX}-$service"
  previous="$(ci_field "$service" taskDefinitionArn)"
  ci_output "previous_${service}_task_definition" "$previous"
  digest=$API_DIGEST
  [ "$service" = worker ] && digest=$WORKER_DIGEST
  if [ "$(ci_field "$service" digest)" = "$digest" ]; then
    rehearsal_log "$name already runs $digest"
    ci_output "${service}_task_definition" "$previous"
    continue
  fi
  image="$(ci_field "$service" repository)@$digest"

  # The next revision of the running definition: the same document with the read-only
  # fields removed, the same tags, and one field changed.
  FSS_SERVICE="$service" FSS_WORK="$CI_WORK" FSS_IMAGE="$image" python3 - <<'PY' || exit 1
# ci-deploy-next-revision
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
    >"$CI_WORK/$service-registered.json" || ci_fail "ECS refused the next revision of $name; nothing has been rolled"
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
  # the one field allowed to differ. A registration that changed anything else — a
  # command, an environment variable, a secret reference, a role — is deregistered
  # before any service names it.
  release_aws "$CI_ENVIRONMENT" ecs describe-task-definition --task-definition "$revision" --include TAGS --output json \
    >"$CI_WORK/$service-new.json" || { ci_deregister "$revision" "it could not be described back"; ci_fail "ECS did not describe $revision"; }
  if ! difference="$(FSS_RUNNING="$CI_WORK/$service-definition.json" FSS_NEW="$CI_WORK/$service-new.json" FSS_IMAGE="$image" python3 - <<'PY'
# ci-deploy-compare-revisions
import json, os, sys
env = os.environ
DERIVED = ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
           "registeredAt", "registeredBy", "deregisteredAt")

def normal(path, image=None):
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
    ci_fail "the revision ECS registered for $name differs from the running one: $difference. Nothing was rolled."
  fi
  ci_output "${service}_task_definition" "$revision"

  rehearsal_log "rolling $name from $previous to $revision"
  release_aws "$CI_ENVIRONMENT" ecs update-service --cluster "$CLUSTER_ARN" --service "$name" --task-definition "$revision" \
    --output json >/dev/null || { ci_deregister "$revision" "ECS refused to roll to it"; ci_fail "ECS refused to point $name at $revision; it still runs $previous"; }

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
    ci_fail "$name was rolled back by ECS to $previous and does not run $digest. Nothing after it was touched."
  fi
  ci_fail "$name names ${observed:-an unknown revision} and does not run $digest on every task; read its events with aws ecs describe-services. Nothing after it was touched."
done

EXPECT_SENDING=disabled
[ "$(ci_field api sendingEnabled)" = true ] && EXPECT_SENDING=enabled
ci_output expect_sending "$EXPECT_SENDING"
rehearsal_log "deployed: worker $WORKER_DIGEST, then api $API_DIGEST, each held to its digest"
