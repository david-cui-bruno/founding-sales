#!/usr/bin/env bash
# The two container images, from CI's build to production's repositories (P7, 26
# September 2026; it replaces release-images.sh and release-promote.sh).
#
#   infra/scripts/images.sh inputs
#   infra/scripts/images.sh verify  <image reference> <api|worker> <schema min> <schema max>
#   infra/scripts/images.sh record  <commit> <run id> <run attempt> <api digest> <worker digest> <out file> \
#                                   --api-range <min>-<max> --worker-range <min>-<max>
#   infra/scripts/images.sh pin     <commit> <out file>
#   infra/scripts/images.sh promote <image-digests.json | image-pin.json> [--app-only]
#
# The images workflow's `publish` job pushes `fss-rh-<image>:ci-<commit>` on every push
# to main that changes an image input, pulls it back by digest, runs `verify` on that, and
# uploads what `record` writes as the artifact `fss-image-digests`. That artifact is the one
# place a digest comes from; nothing is rebuilt after it.
#
#   * inputs  — every path whose change changes an image; the images workflow's
#     `push.paths` is this list in glob form.
#   * verify  — arm64; `--selftest` accepts the declared range and refuses one below it;
#     runs as node, never uid 0; no test directory and no development dependency.
#   * record  — `fss.image-digests.v1`: repositories, digests and the schema range each image
#     declares (`schemaRange`, the range `verify` just held its `--selftest` to), never a
#     registry host. The CI deploy reads the ranges from here (P6, 27 September 2026).
#   * pin     — the images of <commit>: the newest green push run of the images workflow
#     on main whose commit is an ancestor of <commit> with byte-identical image inputs (so
#     a script- or docs-only commit pins the last commit that changed an image), and the
#     green gate run of that images commit, which `record.sh from-ci` builds the release
#     record from. Writes `fss.image-pin.v1` and prints `api_digest=`, `worker_digest=`,
#     `images_run_id=`, `images_commit=`, `gate_run_id=`. Needs GITHUB_REPOSITORY and the
#     history (fetch-depth 0). Looks at the newest 25 green runs: the rehearsal
#     repositories keep 30 tagged images.
#   * promote — copies both digests from fss-rh-* to fss-prod-* registry to registry
#     (`docker buildx imagetools create --prefer-index=false`), never rebuilding, and reads
#     each back: the tag must name the digest. A digest production already holds under a
#     tag is `already-present` and nothing is copied (running it twice is running it once);
#     one it holds untagged, or that a copy wrapped in an index, is tagged in place from its
#     own manifest bytes (`put-image --image-digest`), as `ci-<commit>` or `ci-<commit>-image`.
#     A tag naming another digest is never overwritten (the repositories are IMMUTABLE).
#     `--app-only` is accepted for the old callers and means nothing.
#
# Seams: FSS_GH_COMMAND (gh), FSS_DOCKER_COMMAND (docker), FSS_REHEARSAL_AWS_COMMAND
# (aws). FSS_REHEARSAL_DRY_RUN=1 makes verify and promote print their calls and make none.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

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
PIN_SEARCH_DEPTH=25
PROMOTE_SOURCES='fss-rh-api fss-rh-worker'
PROMOTE_DESTINATIONS='fss-prod-api fss-prod-worker'

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
  [[ "$2" =~ ^[0-9a-f]{40}$ ]] || images_fail "$1 '$2' is not a full forty-character commit"
}

require_digest() {
  [[ "$2" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || images_fail "$1 '$2' is not an image digest. The release compares digests, and a tag is mutable."
}

images_inputs() {
  printf '%s\n' "${IMAGE_INPUTS[@]}"
}

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
images_verify() {
  local reference=${1:-} service=${2:-} minimum=${3:-} maximum=${4:-} architecture user uid found stale
  [ -n "$reference" ] || images_fail "verify needs an image reference"
  case "$service" in api | worker) ;; *) images_fail "verify needs the service, api or worker, not '$service'" ;; esac
  [[ "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ ]] || images_fail "verify needs the declared schema range as two integers"
  rehearsal_refuse_production_arguments "$reference" || exit 1

  if rehearsal_dry_run; then
    images_docker image inspect "$reference" --format '{{.Architecture}}'
  else
    architecture="$(images_docker image inspect "$reference" --format '{{.Architecture}}')"
    echo "$service architecture: $architecture"
    [ "$architecture" = "arm64" ] || images_fail "$reference is $architecture; the task definitions run linux/arm64"
  fi
  # --selftest reads the environment, prints its decisions and exits; it opens nothing.
  images_docker run --rm --platform linux/arm64 \
    -e "FSS_SCHEMA_MIN=$minimum" -e "FSS_SCHEMA_MAX=$maximum" \
    -e DATABASE_URL='postgresql://ci.invalid/fss' \
    "$reference" --selftest
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
    images_docker run --rm --platform linux/arm64 --entrypoint sh "$reference" \
      -c 'find packages apps -type d \( -name test -o -name tests -o -name testing \)'
  else
    user="$(images_docker image inspect "$reference" --format '{{.Config.User}}')"
    [ "$user" = "node" ] || images_fail "$reference runs as '$user', not node"
    uid="$(images_docker run --rm --platform linux/arm64 --entrypoint id "$reference" -u)"
    [ "$uid" != "0" ] || images_fail "$reference runs as uid 0"
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
images_record() {
  local commit=${1:-} run_id=${2:-} attempt=${3:-} api=${4:-} worker=${5:-} out=${6:-} api_range='' worker_range='' range
  shift 6 2>/dev/null || shift "$#"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --api-range) api_range=${2:-}; shift 2 ;;
      --worker-range) worker_range=${2:-}; shift 2 ;;
      *) images_fail "record does not take '$1'" ;;
    esac
  done
  require_commit "the commit" "$commit"
  for range in "$api_range" "$worker_range"; do
    [[ "$range" =~ ^[0-9]{1,4}-[0-9]{1,4}$ ]] \
      || images_fail "record needs --api-range and --worker-range as <min>-<max>, the ranges verify held each image to ('$range')"
  done
  [[ "$run_id" =~ ^[0-9]+$ ]] || images_fail "the run id '$run_id' is not a number"
  [[ "$attempt" =~ ^[0-9]+$ ]] || images_fail "the run attempt '$attempt' is not a number"
  require_digest "the API digest" "$api"
  require_digest "the worker digest" "$worker"
  [ "$api" != "$worker" ] || images_fail "the API and worker digests are identical; one image was pushed under both names"
  [ -n "$out" ] || images_fail "record needs an output file"
  mkdir -p "$(dirname "$out")"
  FSS_COMMIT="$commit" FSS_RUN_ID="$run_id" FSS_ATTEMPT="$attempt" FSS_API="$api" FSS_WORKER="$worker" \
  FSS_API_RANGE="$api_range" FSS_WORKER_RANGE="$worker_range" FSS_INPUTS="$(images_inputs)" FSS_RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" python3 - > "$out" <<'PY'
import json, os
env = os.environ
tag = "ci-" + env["FSS_COMMIT"]
def image(service, digest, variable):
    minimum, maximum = (int(part) for part in env[variable].split("-"))
    return {"repository": "fss-rh-" + service, "tag": tag, "digest": digest,
            "schemaRange": {"minimum": minimum, "maximum": maximum}}
print(json.dumps({
    "schema": "fss.image-digests.v1",
    "commit": env["FSS_COMMIT"],
    "workflowRunId": env["FSS_RUN_ID"],
    "workflowRunAttempt": env["FSS_ATTEMPT"],
    "recordedAt": env["FSS_RECORDED_AT"],
    "images": {
        "api": image("api", env["FSS_API"], "FSS_API_RANGE"),
        "worker": image("worker", env["FSS_WORKER"], "FSS_WORKER_RANGE"),
    },
    "imageInputs": env["FSS_INPUTS"].split("\n"),
}, indent=2))
PY
  rehearsal_log "wrote the digests of $commit to $out"
}

# Prints `<kind> <api digest> <worker digest> <commit>` for a digests or pin file, or refuses.
#   images_read <file> [expected commit] [expected run id]
images_read() {
  local file=$1 commit=${2:-} run_id=${3:-}
  [ -s "$file" ] || images_fail "'$file' is missing or empty"
  FSS_FILE="$file" FSS_COMMIT="$commit" FSS_RUN_ID="$run_id" python3 - <<'PY'
import json, os, re, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

try:
    document = json.load(open(os.environ["FSS_FILE"], encoding="utf-8"))
except (OSError, ValueError) as error:
    fail("the input does not parse: {}".format(error))
if not isinstance(document, dict):
    fail("the input is not a JSON object")
schema = document.get("schema")
if schema == "fss.image-digests.v1":
    kind, commit, run_id = "digests", document.get("commit"), document.get("workflowRunId")
elif schema == "fss.image-pin.v1":
    kind, commit, run_id = "pin", document.get("imagesCommit"), document.get("imagesRunId")
else:
    fail("the input is neither CI's image digests (fss.image-digests.v1) nor a pin (fss.image-pin.v1): {}".format(schema))
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
    fail("the {} file names no images commit".format(kind))
if os.environ["FSS_COMMIT"] and commit != os.environ["FSS_COMMIT"]:
    fail("the digests file names commit {}, not {}".format(commit, os.environ["FSS_COMMIT"]))
if os.environ["FSS_RUN_ID"] and str(run_id) != os.environ["FSS_RUN_ID"]:
    fail("the digests file names run {}, not {}".format(run_id, os.environ["FSS_RUN_ID"]))
images = document.get("images") or {}
found = []
for service in ("api", "worker"):
    entry = images.get(service) or {}
    if entry.get("repository") != "fss-rh-" + service:
        fail("the {} image is in '{}', not fss-rh-{}".format(service, entry.get("repository"), service))
    if entry.get("tag") != "ci-" + commit:
        fail("the {} image is tagged '{}', not ci-{}".format(service, entry.get("tag"), commit))
    value = entry.get("digest")
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        fail("the {} digest '{}' is not an image digest; a tag is mutable".format(service, value))
    found.append(value)
if found[0] == found[1]:
    fail("the API and worker digests are identical; one image was pushed under both names")
print(kind, found[0], found[1], commit)
PY
}

# ---------------------------------------------------------------------------
# pin
# ---------------------------------------------------------------------------
images_pin() {
  local commit=${1:-} out=${2:-} repository=${GITHUB_REPOSITORY:-}
  require_commit "the commit to pin" "$commit"
  [ -n "$out" ] || images_fail "pin needs an output file"
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || images_fail "GITHUB_REPOSITORY is not owner/name"
  git cat-file -e "${commit}^{commit}" 2>/dev/null \
    || images_fail "$commit is not in this checkout; the pin compares history and needs it (fetch-depth: 0)"

  local work candidates run_id head chosen_run='' chosen_commit='' kind api worker gate_run
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-pin.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$work'" EXIT
  images_gh api -X GET "repos/$repository/actions/workflows/greenfield-images.yml/runs" \
    -f branch=main -f event=push -f status=success -f per_page="$PIN_SEARCH_DEPTH" > "$work/runs.json" \
    || images_fail "the images workflow's runs could not be listed"
  candidates="$(FSS_FILE="$work/runs.json" python3 - <<'PY'
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
runs = [run for run in runs if run.get("conclusion") == "success" and run.get("event") == "push"
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
  [ -n "$chosen_run" ] || images_fail "no successful push run of greenfield-images.yml among the newest $PIN_SEARCH_DEPTH built images whose inputs are those of $commit. Either the publish job for the last image change did not succeed (or has not finished), or it is older than the rehearsal repositories keep. Nothing is pinned."

  mkdir -p "$work/artifact"
  images_gh run download "$chosen_run" --repo "$repository" --name fss-image-digests --dir "$work/artifact" >&2 \
    || images_fail "run $chosen_run has no fss-image-digests artifact"
  read -r kind api worker _ <<<"$(images_read "$work/artifact/image-digests.json" "$chosen_commit" "$chosen_run")"
  [ "$kind" = digests ] || exit 1

  # The green gate run of the images commit: the release record is built from it.
  images_gh api -X GET "repos/$repository/actions/workflows/greenfield.yml/runs" \
    -f head_sha="$chosen_commit" -f branch=main -f event=push -f status=success -f per_page=20 > "$work/gate.json" \
    || images_fail "the gate workflow's runs of $chosen_commit could not be listed"
  gate_run="$(FSS_FILE="$work/gate.json" FSS_COMMIT="$chosen_commit" python3 -c '
import json, os
runs = (json.load(open(os.environ["FSS_FILE"], encoding="utf-8")) or {}).get("workflow_runs") or []
runs = [run for run in runs if str(run.get("path", "")).split("@")[0] == ".github/workflows/greenfield.yml"
        and run.get("head_sha") == os.environ["FSS_COMMIT"] and run.get("event") == "push"
        and run.get("head_branch") == "main" and run.get("status") == "completed" and run.get("conclusion") == "success"
        and str(run.get("id", "")).isdigit()]
runs.sort(key=lambda run: (str(run.get("created_at", "")), int(run["id"])), reverse=True)
print(runs[0]["id"] if runs else "")
')"
  [ -n "$gate_run" ] || images_fail "no green Greenfield gate run of a push to main at the images commit $chosen_commit, so no release record can be built for its images"

  mkdir -p "$(dirname "$out")"
  FSS_COMMIT="$commit" FSS_IMAGES_COMMIT="$chosen_commit" FSS_RUN="$chosen_run" FSS_GATE="$gate_run" FSS_API="$api" \
  FSS_WORKER="$worker" FSS_INPUTS="$(images_inputs)" python3 - > "$out" <<'PY'
import json, os
env = os.environ
tag = "ci-" + env["FSS_IMAGES_COMMIT"]
print(json.dumps({
    "schema": "fss.image-pin.v1",
    "commit": env["FSS_COMMIT"],
    "imagesCommit": env["FSS_IMAGES_COMMIT"],
    "imagesRunId": env["FSS_RUN"],
    "gateRunId": env["FSS_GATE"],
    "images": {
        "api": {"repository": "fss-rh-api", "tag": tag, "digest": env["FSS_API"]},
        "worker": {"repository": "fss-rh-worker", "tag": tag, "digest": env["FSS_WORKER"]},
    },
    "imageInputs": env["FSS_INPUTS"].split("\n"),
    "imageInputsUnchanged": True,
}, indent=2))
PY
  rehearsal_log "pinned $commit to the images run $chosen_run built at $chosen_commit (gate run $gate_run)" >&2
  printf 'api_digest=%s\nworker_digest=%s\nimages_run_id=%s\nimages_commit=%s\ngate_run_id=%s\n' \
    "$api" "$worker" "$chosen_run" "$chosen_commit" "$gate_run"
}

# ---------------------------------------------------------------------------
# promote
# ---------------------------------------------------------------------------

# The only ECR calls promote makes, each against the four literal repositories; every one
# is a read but put-image, which may only tag a production repository.
#   promote_aws <describe-images|describe-repositories|batch-get-image|put-image> <repository> [argument...]
promote_aws() {
  local operation=$1 repository=$2 flag=--repository-name
  shift 2
  case "$operation" in
    describe-images | describe-repositories | batch-get-image) ;;
    put-image)
      case " $PROMOTE_DESTINATIONS " in
        *" $repository "*) ;;
        *) images_fail "put-image may only tag a production repository, not '$repository'" ;;
      esac
      ;;
    *) images_fail "promote may only read ECR and tag a production image, not '$operation'" ;;
  esac
  case " $PROMOTE_SOURCES $PROMOTE_DESTINATIONS " in
    *" $repository "*) ;;
    *) images_fail "'$repository' is not one of the four repositories promote knows" ;;
  esac
  [ "$operation" = describe-repositories ] && flag=--repository-names
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecr $operation $flag $repository $*"
    return 0
  fi
  command "$(rehearsal_aws_command)" ecr "$operation" "$flag" "$repository" "$@"
}

repository_uri() {
  local repository=$1 uri
  if rehearsal_dry_run; then
    promote_aws describe-repositories "$repository" --query 'repositories[0].repositoryUri' --output text >&2
    echo "<registry>/$repository"
    return 0
  fi
  uri="$(promote_aws describe-repositories "$repository" --query 'repositories[0].repositoryUri' --output text)" \
    || images_fail "ECR does not describe $repository"
  case "$uri" in
    *.dkr.ecr.*.amazonaws.com/"$repository") echo "$uri" ;;
    *) images_fail "ECR describes $repository as '$uri', which is not a repository URI" ;;
  esac
}

# The digest a tag names, or nothing when the tag does not exist.
digest_of_tag() {
  local repository=$1 tag=$2 output status
  set +e
  output="$(promote_aws describe-images "$repository" --image-ids "imageTag=$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then printf '%s' "$output"; return 0; fi
  case "$output" in *ImageNotFoundException*) return 0 ;; esac
  printf '%s\n' "$output" >&2
  images_fail "could not read $repository:$tag"
}

# `present` or `absent`; any other error is a refusal.
digest_presence() {
  local repository=$1 digest=$2 output status
  set +e
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageDigest' --output text 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ] && [ "$output" = "$digest" ]; then echo present; return 0; fi
  case "$output" in *ImageNotFoundException*) echo absent; return 0 ;; esac
  printf '%s\n' "$output" >&2
  images_fail "could not read $repository@$digest"
}

media_type_of() {
  local repository=$1 digest=$2 output
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageManifestMediaType' --output text)" \
    || images_fail "could not read the manifest type of $repository@$digest"
  case "$output" in
    application/vnd.oci.image.manifest.v1+json | application/vnd.docker.distribution.manifest.v2+json \
      | application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json)
      printf '%s' "$output" ;;
    *) images_fail "$repository@$digest is a '$output', which is not an image manifest or index" ;;
  esac
}

tag_of_digest() {
  local repository=$1 digest=$2 output
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageTags[0]' --output text)" \
    || images_fail "could not read the tags of $repository@$digest"
  [ "$output" = None ] || printf '%s' "$output"
}

# Tag a digest already in a production repository from its own manifest bytes, as
# $PROMOTE_TAG or $PROMOTE_TAG-image, whichever is free or already names it. Prints the tag.
tag_in_place() {
  local repository=$1 digest=$2 media_type=$3 tag='' candidate holder work
  for candidate in "$PROMOTE_TAG" "$PROMOTE_TAG-image"; do
    [ "${#candidate}" -le 128 ] || continue
    holder="$(digest_of_tag "$repository" "$candidate")"
    if [ -z "$holder" ] || [ "$holder" = None ]; then tag=$candidate; break; fi
    if [ "$holder" = "$digest" ]; then printf '%s' "$candidate"; return 0; fi
    rehearsal_log "$repository:$candidate already names $holder; not that one" >&2
  done
  [ -n "$tag" ] || images_fail "$repository has no free tag for $digest: $PROMOTE_TAG and $PROMOTE_TAG-image both name other images"
  work="$(mktemp -d)"
  if ! promote_aws batch-get-image "$repository" --image-ids "imageDigest=$digest" \
      --accepted-media-types "$media_type" --output json >"$work/image.json"; then
    rm -rf "$work"
    images_fail "could not read the manifest of $repository@$digest"
  fi
  if ! FSS_IMAGE="$work/image.json" FSS_MANIFEST="$work/manifest.json" FSS_DIGEST="$digest" python3 - <<'PY'
import json, os, sys
images = (json.load(open(os.environ["FSS_IMAGE"], encoding="utf-8")) or {}).get("images") or []
if len(images) != 1 or (images[0].get("imageId") or {}).get("imageDigest") != os.environ["FSS_DIGEST"]:
    sys.exit("ECR did not return exactly the image asked for")
with open(os.environ["FSS_MANIFEST"], "w", encoding="utf-8", newline="") as handle:
    handle.write(images[0]["imageManifest"])
PY
  then
    rm -rf "$work"
    images_fail "ECR did not return the manifest of $repository@$digest"
  fi
  if ! promote_aws put-image "$repository" --image-tag "$tag" --image-digest "$digest" \
      --image-manifest "file://$work/manifest.json" --image-manifest-media-type "$media_type" >/dev/null; then
    rm -rf "$work"
    images_fail "could not tag $repository@$digest as $tag"
  fi
  rm -rf "$work"
  holder="$(digest_of_tag "$repository" "$tag")"
  [ "$holder" = "$digest" ] || images_fail "$repository:$tag is ${holder:-<nothing>} after tagging $digest in place; the digest still differs"
  printf '%s' "$tag"
}

promote_one() {
  local service=$1 digest=$2 source_uri=$3 destination_uri=$4
  local source_repository="fss-rh-$service" destination_repository="fss-prod-$service" presence existing copied media_type held tagged
  if rehearsal_dry_run; then
    promote_aws describe-images "$source_repository" --image-ids "imageDigest=$digest"
    promote_aws describe-images "$destination_repository" --image-ids "imageDigest=$digest"
    rehearsal_plan "stop here if $destination_repository already holds $digest under a tag; tag it in place if it holds it under none"
    promote_aws describe-images "$destination_repository" --image-ids "imageTag=$PROMOTE_TAG"
    images_docker buildx imagetools create --tag "$destination_uri:$PROMOTE_TAG" --prefer-index=false "$source_uri@$digest"
    rehearsal_plan "read $destination_repository:$PROMOTE_TAG back; if it is not $digest, tag $digest itself in place"
    return 0
  fi
  presence="$(digest_presence "$source_repository" "$digest")"
  [ "$presence" = present ] || images_fail "$source_repository has no image $digest; nothing to promote (expired, or never published)"
  media_type="$(media_type_of "$source_repository" "$digest")"
  presence="$(digest_presence "$destination_repository" "$digest")"
  if [ "$presence" = present ]; then
    held="$(tag_of_digest "$destination_repository" "$digest")"
    if [ -n "$held" ]; then
      rehearsal_log "$destination_repository already holds $digest as $held; nothing to copy"
      echo "$service $destination_repository $digest already-present"
      return 0
    fi
    tagged="$(tag_in_place "$destination_repository" "$digest" "$media_type")"
    rehearsal_log "$destination_repository held $digest under no tag; it is $tagged now"
    echo "$service $destination_repository $digest tagged-in-place $tagged"
    return 0
  fi
  existing="$(digest_of_tag "$destination_repository" "$PROMOTE_TAG")"
  if [ -n "$existing" ] && [ "$existing" != "None" ] && [ "$existing" != "$digest" ]; then
    images_fail "$destination_repository:$PROMOTE_TAG already names $existing; tags are immutable, so it is not overwritten"
  fi
  images_docker buildx imagetools create --tag "$destination_uri:$PROMOTE_TAG" --prefer-index=false "$source_uri@$digest" >/dev/null
  copied="$(digest_of_tag "$destination_repository" "$PROMOTE_TAG")"
  if [ "$copied" != "$digest" ]; then
    [ "$(digest_presence "$destination_repository" "$digest")" = present ] \
      || images_fail "$destination_repository:$PROMOTE_TAG is ${copied:-<nothing>}, and the release is $digest: the digest changed in the copy, and $digest itself is not in $destination_repository"
    tagged="$(tag_in_place "$destination_repository" "$digest" "$media_type")"
    rehearsal_log "$destination_repository:$tagged = $digest ($PROMOTE_TAG names the index the copy wrapped it in)"
    echo "$service $destination_repository $digest copied-and-tagged $tagged"
    return 0
  fi
  rehearsal_log "$destination_repository:$PROMOTE_TAG = $digest"
  echo "$service $destination_repository $digest copied"
}

images_promote() {
  local input=${1:-} kind api worker commit registry source_api source_worker destination_api destination_worker
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --app-only) shift ;;
      *) images_fail "promote does not take '$1'" ;;
    esac
  done
  [ -n "$input" ] || images_fail "usage: images.sh promote <image-digests.json | image-pin.json>"
  read -r kind api worker commit <<<"$(images_read "$input")"
  [ -n "${commit:-}" ] || exit 1
  PROMOTE_TAG="ci-$commit"
  rehearsal_log "promoting the $kind of $commit: api $api, worker $worker, tagged $PROMOTE_TAG in production"
  source_api="$(repository_uri fss-rh-api)"
  source_worker="$(repository_uri fss-rh-worker)"
  destination_api="$(repository_uri fss-prod-api)"
  destination_worker="$(repository_uri fss-prod-worker)"
  registry="${destination_api%%/*}"
  [ "${source_api%%/*}" = "$registry" ] && [ "${source_worker%%/*}" = "$registry" ] && [ "${destination_worker%%/*}" = "$registry" ] \
    || images_fail "the four repositories are not in one registry; this copy is within one account and region"
  # The password goes through a pipe, never an argument.
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecr get-login-password | docker login --username AWS --password-stdin $registry"
  else
    command "$(rehearsal_aws_command)" ecr get-login-password | images_docker login --username AWS --password-stdin "$registry" >/dev/null
  fi
  promote_one api "$api" "$source_api" "$destination_api"
  promote_one worker "$worker" "$source_worker" "$destination_worker"
  rehearsal_log "both images are in production by digest"
}

SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  inputs) images_inputs ;;
  verify) images_verify "$@" ;;
  record) images_record "$@" ;;
  pin) images_pin "$@" ;;
  promote) images_promote "$@" ;;
  *)
    echo "usage: $(basename "$0") inputs | verify <image> <api|worker> <min> <max> | record <commit> <run id> <attempt> <api digest> <worker digest> <out> --api-range <min>-<max> --worker-range <min>-<max> | pin <commit> <out> | promote <image-digests.json | image-pin.json>" >&2
    exit 2
    ;;
esac
