#!/usr/bin/env bash
# The two container images, as CI publishes them (lane g74; audit O17 and O10).
#
#   infra/scripts/release-images.sh inputs
#   infra/scripts/release-images.sh verify <image reference> <api|worker> <schema min> <schema max>
#   infra/scripts/release-images.sh record <commit> <run id> <run attempt> <api digest> <worker digest> <out file>
#   infra/scripts/release-images.sh pin    <commit> <out file>
#
# ## Why this exists
#
# Until lane g74 the image digests a release was about came from an operator's
# checkout: `greenfield-images.yml` built and verified both images and printed a digest
# that was never the registry's, and the operator rebuilt from the same commit and pushed.
# Two builds of one commit are two sets of bytes. Now the `publish` job of
# `greenfield-images.yml` pushes on every push to main that changes an image input, to
# the two stable rehearsal repositories only (`fss-rh-api`, `fss-rh-worker`), as
# `ci-<commit>`, with the rehearsal role it already had (`fss-rh-deploy` holds `ecr:*`
# on `repository/fss-rh*`; no IAM statement and no trust relationship changed). It then
# pulls what it pushed **by digest** and runs `verify` against that, and `record` writes
# the digests as the workflow artifact `fss-image-digests`. That artifact is the one
# place a digest comes from: the weekly rehearsal pins to it (`pin`) and the operator's
# production copy reads it (`release-promote.sh`), and neither rebuilds.
#
# ## The four subcommands
#
#   * `inputs` — every path whose change changes an image, one per line. The images
#     workflow's `push.paths` must list exactly these (a check in the release suite
#     compares them), so "the images of commit X" and "the images of commit Y" are the
#     same bytes whenever `git diff X Y -- $(inputs)` is empty.
#   * `verify` — the checks `greenfield-images.yml` ran inline before g74, now run on a
#     pull request against the local build and on main against the pulled-by-digest
#     image: arm64; `--selftest` accepts the declared range and refuses one below it;
#     runs as `node`, never uid 0; ships no test directory and no development dependency.
#   * `record` — the digests JSON (`fss.image-digests.v1`). It names repositories, never
#     a registry host: the host carries the account, and the account is a secret here.
#   * `pin` — the CI digests for a commit. The newest successful push run of the images
#     workflow on main whose commit is an ancestor of <commit> and whose image inputs are
#     byte-identical to <commit>'s (`git diff --quiet`). The images workflow runs only when
#     an input changes, so a documentation commit on top of the last image change pins
#     the images of that change — the same inputs, therefore the same image. Anything
#     else is a refusal: no such run, a run whose artifact is missing or names another
#     commit, a digest that is not a digest, or one image under both names.
#
# `pin` looks at the newest 25 successful runs and no further. The rehearsal
# repositories keep 30 tagged images (`infra/modules/registry`), so a match older than
# that may already be expired, and a rehearsal that fails to pull five minutes into a
# deployment is worse than a refusal here.
#
# Seams, for the offline checks (`test/release/rehearsalCadence.check.ts`):
#   FSS_GH_COMMAND       the GitHub CLI (default `gh`); `pin` only
#   FSS_DOCKER_COMMAND   the Docker CLI (default `docker`); `verify` only
# Dry run: FSS_REHEARSAL_DRY_RUN=1 makes `verify` print its commands and run none.

# shellcheck source=infra/scripts/rehearsal-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

# The one list. `.github/workflows/greenfield-images.yml` `push.paths` is this list in
# glob form, and the release suite fails when the two differ.
IMAGE_INPUTS=(
  Dockerfile.api
  Dockerfile.worker
  Dockerfile.api.dockerignore
  Dockerfile.worker.dockerignore
  apps
  packages
  certs
  package.json
  package-lock.json
  .github/workflows/greenfield-images.yml
)

IMAGE_DIGEST_SHAPE='^sha256:[0-9a-f]{64}$'
COMMIT_SHAPE='^[0-9a-f]{40}$'
IMAGE_DIGESTS_ARTIFACT='fss-image-digests'
IMAGE_DIGESTS_FILE='image-digests.json'
IMAGES_WORKFLOW='greenfield-images.yml'
PIN_SEARCH_DEPTH=25

images_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

images_gh() {
  command "${FSS_GH_COMMAND:-gh}" "$@"
}

images_docker() {
  if rehearsal_dry_run; then
    rehearsal_plan "docker $*"
    return 0
  fi
  command "${FSS_DOCKER_COMMAND:-docker}" "$@"
}

require_commit() {
  local what=$1 value=$2
  [[ "$value" =~ $COMMIT_SHAPE ]] || images_fail "$what '$value' is not a full forty-character commit"
}

require_digest() {
  local what=$1 value=$2
  [[ "$value" =~ $IMAGE_DIGEST_SHAPE ]] \
    || images_fail "$what '$value' is not an image digest. The release compares digests, and a tag is mutable."
}

subcommand_inputs() {
  printf '%s\n' "${IMAGE_INPUTS[@]}"
}

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
subcommand_verify() {
  local reference=${1:-} service=${2:-} minimum=${3:-} maximum=${4:-}
  [ -n "$reference" ] || images_fail "verify needs an image reference"
  case "$service" in api | worker) ;; *) images_fail "verify needs the service, api or worker, not '$service'" ;; esac
  [[ "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ ]] || images_fail "verify needs the declared schema range as two integers"
  rehearsal_refuse_production_arguments "$reference" || exit 1

  local architecture user uid found stale
  if rehearsal_dry_run; then
    images_docker image inspect "$reference" --format '{{.Architecture}}'
  else
    architecture="$(images_docker image inspect "$reference" --format '{{.Architecture}}')"
    echo "$service architecture: $architecture"
    [ "$architecture" = "arm64" ] || images_fail "$reference is $architecture; the task definitions run linux/arm64"
  fi

  # --selftest reads the environment, prints the decisions and exits. It opens no
  # socket, no database and no AWS client, so this proves the production dependency set
  # without reaching anything.
  images_docker run --rm --platform linux/arm64 \
    -e "FSS_SCHEMA_MIN=$minimum" -e "FSS_SCHEMA_MAX=$maximum" \
    -e DATABASE_URL='postgresql://ci.invalid/fss' \
    "$reference" --selftest

  # One below the minimum is always outside the range the image supports, whatever the
  # ranges become, and both processes refuse a task definition that declares it.
  stale="$((minimum - 1))"
  if rehearsal_dry_run; then
    rehearsal_plan "refuse unless $reference --selftest exits non-zero for the range {$stale,$stale}"
  elif images_docker run --rm --platform linux/arm64 \
      -e "FSS_SCHEMA_MIN=$stale" -e "FSS_SCHEMA_MAX=$stale" \
      -e DATABASE_URL='postgresql://ci.invalid/fss' \
      "$reference" --selftest; then
    images_fail "$reference accepted a declared schema range it does not support"
  fi

  if rehearsal_dry_run; then
    images_docker image inspect "$reference" --format '{{.Config.User}}'
    images_docker run --rm --platform linux/arm64 --entrypoint id "$reference" -u
  else
    user="$(images_docker image inspect "$reference" --format '{{.Config.User}}')"
    [ "$user" = "node" ] || images_fail "$reference runs as '$user', not node"
    uid="$(images_docker run --rm --platform linux/arm64 --entrypoint id "$reference" -u)"
    [ "$uid" != "0" ] || images_fail "$reference runs as uid 0"
  fi

  # Named directories do not scale (the PostgreSQL harness is packages/domain/db/testing,
  # the recorded research fixtures packages/domain/research/testing), so this asks the
  # built image the general question: is there any test directory in it at all?
  if rehearsal_dry_run; then
    images_docker run --rm --platform linux/arm64 --entrypoint sh "$reference" \
      -c 'find packages apps -type d \( -name test -o -name tests -o -name testing \)'
  else
    found="$(images_docker run --rm --platform linux/arm64 --entrypoint sh "$reference" \
      -c 'find packages apps -type d \( -name test -o -name tests -o -name testing \) 2>/dev/null')"
    if [ -n "$found" ]; then
      echo "$found" >&2
      images_fail "$reference ships a test directory; add it to Dockerfile.$service.dockerignore and remove it in Dockerfile.$service"
    fi
  fi
  images_docker run --rm --platform linux/arm64 --entrypoint sh "$reference" \
    -c '! ls node_modules/vitest node_modules/typescript node_modules/embedded-postgres 2>/dev/null'
  rehearsal_log "$service: arm64, selftest accepts {$minimum,$maximum} and refuses {$stale,$stale}, runs as node, no test directory, no development dependency"
}

# ---------------------------------------------------------------------------
# record
# ---------------------------------------------------------------------------
subcommand_record() {
  local commit=${1:-} run_id=${2:-} attempt=${3:-} api=${4:-} worker=${5:-} out=${6:-}
  require_commit "the commit" "$commit"
  [[ "$run_id" =~ ^[0-9]+$ ]] || images_fail "the run id '$run_id' is not a number"
  [[ "$attempt" =~ ^[0-9]+$ ]] || images_fail "the run attempt '$attempt' is not a number"
  require_digest "the API digest" "$api"
  require_digest "the worker digest" "$worker"
  [ "$api" != "$worker" ] || images_fail "the API and worker digests are identical; one image was pushed under both names"
  [ -n "$out" ] || images_fail "record needs an output file"

  mkdir -p "$(dirname "$out")"
  FSS_COMMIT="$commit" FSS_RUN_ID="$run_id" FSS_ATTEMPT="$attempt" FSS_API="$api" FSS_WORKER="$worker" \
  FSS_INPUTS="$(subcommand_inputs)" FSS_RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 - > "$out" <<'PY'
import json, os
env = os.environ
tag = "ci-" + env["FSS_COMMIT"]
print(json.dumps({
    "schema": "fss.image-digests.v1",
    "commit": env["FSS_COMMIT"],
    "workflowRunId": env["FSS_RUN_ID"],
    "workflowRunAttempt": env["FSS_ATTEMPT"],
    "recordedAt": env["FSS_RECORDED_AT"],
    "images": {
        "api": {"repository": "fss-rh-api", "tag": tag, "digest": env["FSS_API"]},
        "worker": {"repository": "fss-rh-worker", "tag": tag, "digest": env["FSS_WORKER"]},
    },
    "imageInputs": env["FSS_INPUTS"].split("\n"),
}, indent=2))
PY
  rehearsal_log "wrote the digests of $commit to $out"
}

# Read and judge a digests JSON. Prints `api worker tag` on stdout, or refuses.
#
#   images_read_digests <file> <expected commit> [expected run id]
images_read_digests() {
  local file=$1 commit=$2 run_id=${3:-}
  [ -s "$file" ] || images_fail "$file is missing or empty"
  FSS_FILE="$file" FSS_COMMIT="$commit" FSS_RUN_ID="$run_id" python3 - <<'PY'
import json, os, re, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

try:
    document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
except (OSError, ValueError) as error:
    fail("the digests file does not parse: {}".format(error))
if not isinstance(document, dict) or document.get("schema") != "fss.image-digests.v1":
    fail("the digests file is not fss.image-digests.v1")
commit = os.environ["FSS_COMMIT"]
if document.get("commit") != commit:
    fail("the digests file names commit {}, not {}".format(document.get("commit"), commit))
run_id = os.environ["FSS_RUN_ID"]
if run_id and str(document.get("workflowRunId")) != run_id:
    fail("the digests file names run {}, not {}".format(document.get("workflowRunId"), run_id))
images = document.get("images") or {}
digest = re.compile(r"^sha256:[0-9a-f]{64}$")
answer = []
for service in ("api", "worker"):
    entry = images.get(service) or {}
    if entry.get("repository") != "fss-rh-" + service:
        fail("the {} image is in '{}', not fss-rh-{}".format(service, entry.get("repository"), service))
    if not isinstance(entry.get("digest"), str) or not digest.match(entry["digest"]):
        fail("the {} digest '{}' is not an image digest".format(service, entry.get("digest")))
    if entry.get("tag") != "ci-" + commit:
        fail("the {} image is tagged '{}', not ci-{}".format(service, entry.get("tag"), commit))
    answer.append(entry["digest"])
if answer[0] == answer[1]:
    fail("the API and worker digests are identical; one image was pushed under both names")
print(answer[0], answer[1], "ci-" + commit)
PY
}

# ---------------------------------------------------------------------------
# pin
# ---------------------------------------------------------------------------
subcommand_pin() {
  local commit=${1:-} out=${2:-} repository=${GITHUB_REPOSITORY:-}
  require_commit "the commit to pin" "$commit"
  [ -n "$out" ] || images_fail "pin needs an output file"
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || images_fail "GITHUB_REPOSITORY is not owner/name"
  git cat-file -e "${commit}^{commit}" 2>/dev/null \
    || images_fail "$commit is not in this checkout; the pin compares history and needs it (fetch-depth: 0)"

  local work runs candidates run_id head chosen_run='' chosen_commit='' digests api worker tag
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-pin.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now; the local is gone by the time EXIT runs
  trap "rm -rf '$work'" EXIT
  runs="$work/runs.json"
  images_gh api -X GET "repos/$repository/actions/workflows/$IMAGES_WORKFLOW/runs" \
    -f branch=main -f event=push -f status=success -f per_page="$PIN_SEARCH_DEPTH" > "$runs" \
    || images_fail "the images workflow's runs could not be listed"

  candidates="$(FSS_FILE="$runs" python3 - <<'PY'
import json, os, re, sys
try:
    document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
except ValueError:
    print("FAIL: the runs listing does not parse", file=sys.stderr)
    sys.exit(1)
runs = document.get("workflow_runs") if isinstance(document, dict) else None
if not isinstance(runs, list):
    print("FAIL: the runs listing has no workflow_runs", file=sys.stderr)
    sys.exit(1)
# Newest first, whatever order the API used; only runs that are what the query asked for.
runs = [run for run in runs
        if run.get("conclusion") == "success" and run.get("event") == "push"
        and run.get("head_branch") == "main"
        and re.match(r"^[0-9a-f]{40}$", str(run.get("head_sha", ""))) and str(run.get("id", "")).isdigit()]
runs.sort(key=lambda run: str(run.get("created_at", "")), reverse=True)
for run in runs:
    print(run["id"], run["head_sha"])
PY
)" || exit 1

  while read -r run_id head; do
    [ -n "$run_id" ] || continue
    git cat-file -e "${head}^{commit}" 2>/dev/null || continue
    git merge-base --is-ancestor "$head" "$commit" || continue
    if git diff --quiet "$head" "$commit" -- "${IMAGE_INPUTS[@]}"; then
      chosen_run=$run_id
      chosen_commit=$head
      break
    fi
    rehearsal_log "run $run_id built $head, whose image inputs differ from $commit's; looking further back" >&2
  done <<<"$candidates"

  if [ -z "$chosen_run" ]; then
    images_fail "no successful push run of $IMAGES_WORKFLOW among the newest $PIN_SEARCH_DEPTH built images whose inputs are those of $commit. Either the publish job for the last image change did not succeed, or it is older than the rehearsal repositories keep. Nothing is pinned, so nothing runs."
  fi

  mkdir -p "$work/artifact"
  images_gh run download "$chosen_run" --repo "$repository" --name "$IMAGE_DIGESTS_ARTIFACT" --dir "$work/artifact" >&2 \
    || images_fail "run $chosen_run has no $IMAGE_DIGESTS_ARTIFACT artifact"
  digests="$(images_read_digests "$work/artifact/$IMAGE_DIGESTS_FILE" "$chosen_commit" "$chosen_run")" || exit 1
  read -r api worker tag <<<"$digests"

  mkdir -p "$(dirname "$out")"
  FSS_COMMIT="$commit" FSS_IMAGES_COMMIT="$chosen_commit" FSS_RUN="$chosen_run" FSS_API="$api" FSS_WORKER="$worker" \
  FSS_TAG="$tag" FSS_INPUTS="$(subcommand_inputs)" python3 - > "$out" <<'PY'
import json, os
env = os.environ
print(json.dumps({
    "schema": "fss.image-pin.v1",
    "commit": env["FSS_COMMIT"],
    "imagesCommit": env["FSS_IMAGES_COMMIT"],
    "imagesRunId": env["FSS_RUN"],
    "images": {
        "api": {"repository": "fss-rh-api", "tag": env["FSS_TAG"], "digest": env["FSS_API"]},
        "worker": {"repository": "fss-rh-worker", "tag": env["FSS_TAG"], "digest": env["FSS_WORKER"]},
    },
    "imageInputs": env["FSS_INPUTS"].split("\n"),
    "imageInputsUnchanged": True,
}, indent=2))
PY
  rehearsal_log "pinned $commit to the images run $chosen_run built at $chosen_commit" >&2
  printf 'api_digest=%s\nworker_digest=%s\nimages_run_id=%s\nimages_commit=%s\n' "$api" "$worker" "$chosen_run" "$chosen_commit"
}

SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  inputs) subcommand_inputs ;;
  verify) subcommand_verify "$@" ;;
  record) subcommand_record "$@" ;;
  pin) subcommand_pin "$@" ;;
  *)
    echo "usage: $(basename "$0") inputs | verify <image> <api|worker> <min> <max> | record <commit> <run id> <attempt> <api digest> <worker digest> <out> | pin <commit> <out>" >&2
    exit 2
    ;;
esac
