#!/usr/bin/env bash
# Copy the two images from the rehearsal repositories to the production repositories,
# by digest, without rebuilding (lane g74; audit O17).
#
#   infra/scripts/release-promote.sh <release-manifest.json>                 # a green full rehearsal
#   infra/scripts/release-promote.sh <image-digests.json> --app-only         # CI's digests, fast path only
#   ... [--tag <tag>]
#
# Run by the operator, with the admin profile, from a checkout of main. Never by CI with
# a credential: the only workflow that names this script is the release workflow's
# credential-free dry-run job, in dry-run mode, and the release suite fails if any other
# job starts to.
#
# ## What it copies, and from where
#
# The input is one of the two files CI produces, both downloadable from the run that
# wrote them:
#
#   * `release-manifest.json` (`fss.release-manifest.v1`, artifact `fss-release-manifest`
#     of a green `full` rehearsal): the digests the rehearsal passed with. The manifest is
#     checked first — schema, two different digests, the suite `pass` — so a manifest
#     from a run that did not finish is refused before anything is read from ECR;
#   * `image-digests.json` (`fss.image-digests.v1`, artifact `fss-image-digests` of the
#     images workflow's `publish` job): what CI built and verified for a commit, which no
#     full rehearsal has run. The release cadence of 25 September allows exactly one use
#     of that, the app-only fast path (CI → rolling deploy → smoke), so the flag
#     `--app-only` is required to say so out loud; without it this refuses.
#
# For each of the two images:
#
#   1. the digest must exist in `fss-rh-<image>` (read);
#   2. if `fss-prod-<image>` already holds that digest, nothing is copied — running this
#      twice is running it once;
#   3. otherwise the tag must not already name a different digest in production (the
#      repositories are IMMUTABLE, and a tag somebody pushed from a laptop is not
#      overwritten by a copy);
#   4. `docker buildx imagetools create --tag <prod>:<tag> <rh>@<digest>` copies the
#      manifest and its blobs registry-to-registry — the operator convention of
#      `fss-prod-images.sh` — so nothing is rebuilt and nothing passes through the Mac's
#      image store;
#   5. production is read back and the digest must be the same one, or this fails naming
#      both. That comparison is the point: the digest production deploys is the digest
#      that passed.
#
# The four repository names are literals: `fss-rh-api` and `fss-rh-worker` are the only
# sources, `fss-prod-api` and `fss-prod-worker` the only destinations, and no other name
# is accepted from any input. The source is only ever read. Nothing is deleted. The
# registry host comes from ECR itself (`describe-repositories`), so no account is named
# here.
#
# The default tag is the one the image already carries in the rehearsal repository
# (`ci-<commit>`), which keeps production's history readable in the same words; `--tag`
# overrides it for images that came from an operator push.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 prints every call and makes none. Offline seams:
# FSS_REHEARSAL_AWS_COMMAND (the AWS CLI) and FSS_DOCKER_COMMAND (the Docker CLI).

# shellcheck source=infra/scripts/rehearsal-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

PROMOTE_SOURCES='fss-rh-api fss-rh-worker'
PROMOTE_DESTINATIONS='fss-prod-api fss-prod-worker'

promote_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# The only AWS calls this script makes, each checked against the four literal names.
#   promote_aws <describe-images|describe-repositories|get-login-password> <repository> [argument...]
promote_aws() {
  local operation=$1 repository=$2
  shift 2
  case "$operation" in
    describe-images | describe-repositories) ;;
    *) promote_fail "this script may only read ECR, not '$operation'" ;;
  esac
  case " $PROMOTE_SOURCES $PROMOTE_DESTINATIONS " in
    *" $repository "*) ;;
    *) promote_fail "'$repository' is not one of the four repositories this script knows" ;;
  esac
  local flag=--repository-name
  [ "$operation" = describe-repositories ] && flag=--repository-names
  if rehearsal_dry_run; then
    rehearsal_plan "aws ecr $operation $flag $repository $*"
    return 0
  fi
  command "$(rehearsal_aws_command)" ecr "$operation" "$flag" "$repository" "$@"
}

promote_docker() {
  if rehearsal_dry_run; then
    rehearsal_plan "docker $*"
    return 0
  fi
  command "${FSS_DOCKER_COMMAND:-docker}" "$@"
}

INPUT=${1:-}
shift || true
APP_ONLY=0
TAG=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-only) APP_ONLY=1; shift ;;
    --tag) TAG=${2:-}; shift 2 2>/dev/null || promote_fail "--tag needs a value" ;;
    *) promote_fail "unknown argument '$1'" ;;
  esac
done

[ -n "$INPUT" ] || promote_fail "usage: $(basename "$0") <release-manifest.json | image-digests.json> [--app-only] [--tag <tag>]"
[ -s "$INPUT" ] || promote_fail "'$INPUT' is missing or empty"

# kind api-digest worker-digest default-tag
read -r KIND API_DIGEST WORKER_DIGEST DEFAULT_TAG <<<"$(FSS_FILE="$INPUT" python3 - <<'PY'
# release-promote-read
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
digest = re.compile(r"^sha256:[0-9a-f]{64}$")
commit = re.compile(r"^[0-9a-f]{40}$")
schema = document.get("schema")
images = document.get("images") or {}
if schema == "fss.release-manifest.v1":
    kind = "manifest"
    if (document.get("releaseRecord") or {}).get("suite") != "pass":
        fail("the manifest's release record is not a pass")
    tag_commit = (images.get("provenance") or {}).get("commit") or (document.get("checkout") or {}).get("commit")
    tag = "ci-" + tag_commit if (images.get("provenance") or {}).get("source") == "ci" and tag_commit else "-"
elif schema == "fss.image-digests.v1":
    kind = "digests"
    tag_commit = document.get("commit")
    if not isinstance(tag_commit, str) or not commit.match(tag_commit):
        fail("the digests file names no commit")
    tag = "ci-" + tag_commit
else:
    fail("the input is neither a release manifest (fss.release-manifest.v1) nor CI's image digests (fss.image-digests.v1): {}".format(schema))
found = []
for service in ("api", "worker"):
    entry = images.get(service) or {}
    if entry.get("repository") not in (None, "fss-rh-" + service):
        fail("the {} image is in '{}', not fss-rh-{}".format(service, entry.get("repository"), service))
    value = entry.get("digest")
    if not isinstance(value, str) or not digest.match(value):
        fail("the {} digest '{}' is not an image digest; a tag is mutable".format(service, value))
    found.append(value)
if found[0] == found[1]:
    fail("the API and worker digests are identical; one image was pushed under both names")
print(kind, found[0], found[1], tag)
PY
)"
[ -n "${KIND:-}" ] || exit 1

if [ "$KIND" = digests ] && [ "$APP_ONLY" -ne 1 ]; then
  promote_fail "these are CI's digests, and no full rehearsal has passed with them. Promote a release manifest instead, or say --app-only: the one release class the cadence lets reach production without a rehearsal."
fi
if [ "$KIND" = manifest ] && [ "$APP_ONLY" -eq 1 ]; then
  promote_fail "--app-only is for CI's digests; a release manifest is already a rehearsed release"
fi
if [ -z "$TAG" ]; then
  [ "$DEFAULT_TAG" != "-" ] || promote_fail "the manifest's images did not come from CI, so they carry no ci-<commit> tag; name one with --tag"
  TAG=$DEFAULT_TAG
fi
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || promote_fail "'$TAG' is not an image tag"

rehearsal_log "promoting a $KIND: api $API_DIGEST, worker $WORKER_DIGEST, tagged $TAG in production"

# The registry host, from ECR rather than from a literal.
repository_uri() {
  local repository=$1 uri
  if rehearsal_dry_run; then
    promote_aws describe-repositories "$repository" --query 'repositories[0].repositoryUri' --output text >&2
    echo "<registry>/$repository"
    return 0
  fi
  uri="$(promote_aws describe-repositories "$repository" --query 'repositories[0].repositoryUri' --output text)" \
    || promote_fail "ECR does not describe $repository"
  case "$uri" in
    *.dkr.ecr.*.amazonaws.com/"$repository") echo "$uri" ;;
    *) promote_fail "ECR describes $repository as '$uri', which is not a repository URI" ;;
  esac
}

# The digest a tag names in a repository, or nothing when the tag does not exist.
digest_of_tag() {
  local repository=$1 tag=$2 output status
  set +e
  output="$(promote_aws describe-images "$repository" --image-ids "imageTag=$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    printf '%s' "$output"
    return 0
  fi
  case "$output" in
    *ImageNotFoundException*) return 0 ;;
  esac
  printf '%s\n' "$output" >&2
  promote_fail "could not read $repository:$tag"
}

# Whether a repository holds a digest: prints `present` or `absent`, refuses on any other error.
digest_presence() {
  local repository=$1 digest=$2 output status
  set +e
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageDigest' --output text 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ] && [ "$output" = "$digest" ]; then
    echo present
    return 0
  fi
  case "$output" in
    *ImageNotFoundException*) echo absent; return 0 ;;
  esac
  printf '%s\n' "$output" >&2
  promote_fail "could not read $repository@$digest"
}

SOURCE_API="$(repository_uri fss-rh-api)"
SOURCE_WORKER="$(repository_uri fss-rh-worker)"
DESTINATION_API="$(repository_uri fss-prod-api)"
DESTINATION_WORKER="$(repository_uri fss-prod-worker)"
REGISTRY="${DESTINATION_API%%/*}"
[ "${SOURCE_API%%/*}" = "$REGISTRY" ] && [ "${SOURCE_WORKER%%/*}" = "$REGISTRY" ] && [ "${DESTINATION_WORKER%%/*}" = "$REGISTRY" ] \
  || promote_fail "the four repositories are not in one registry; this copy is within one account and region"

# The password goes through a pipe, never an argument.
if rehearsal_dry_run; then
  rehearsal_plan "aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY"
else
  command "$(rehearsal_aws_command)" ecr get-login-password \
    | promote_docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
fi

promote_one() {
  local service=$1 digest=$2 source_uri=$3 destination_uri=$4
  local source_repository="fss-rh-$service" destination_repository="fss-prod-$service" presence existing copied
  if rehearsal_dry_run; then
    promote_aws describe-images "$source_repository" --image-ids "imageDigest=$digest"
    rehearsal_plan "refuse unless $source_repository holds $digest"
    promote_aws describe-images "$destination_repository" --image-ids "imageDigest=$digest"
    rehearsal_plan "stop here if $destination_repository already holds $digest"
    promote_aws describe-images "$destination_repository" --image-ids "imageTag=$TAG"
    rehearsal_plan "refuse if $destination_repository:$TAG names another digest"
    promote_docker buildx imagetools create --tag "$destination_uri:$TAG" "$source_uri@$digest"
    promote_aws describe-images "$destination_repository" --image-ids "imageTag=$TAG"
    rehearsal_plan "refuse unless $destination_repository:$TAG is $digest"
    return 0
  fi

  presence="$(digest_presence "$source_repository" "$digest")"
  [ "$presence" = present ] || promote_fail "$source_repository has no image $digest; nothing to promote (expired, or never published)"

  presence="$(digest_presence "$destination_repository" "$digest")"
  if [ "$presence" = present ]; then
    rehearsal_log "$destination_repository already holds $digest; nothing to copy"
    echo "$service $destination_repository $digest already-present"
    return 0
  fi

  existing="$(digest_of_tag "$destination_repository" "$TAG")"
  if [ -n "$existing" ] && [ "$existing" != "None" ] && [ "$existing" != "$digest" ]; then
    promote_fail "$destination_repository:$TAG already names $existing; tags are immutable, so name another with --tag"
  fi

  promote_docker buildx imagetools create --tag "$destination_uri:$TAG" "$source_uri@$digest" >/dev/null

  copied="$(digest_of_tag "$destination_repository" "$TAG")"
  if [ "$copied" != "$digest" ]; then
    promote_fail "$destination_repository:$TAG is ${copied:-<nothing>}, and the release is $digest: the digest changed in the copy"
  fi
  rehearsal_log "$destination_repository:$TAG = $digest, the digest that passed"
  echo "$service $destination_repository $digest copied"
}

promote_one api "$API_DIGEST" "$SOURCE_API" "$DESTINATION_API"
promote_one worker "$WORKER_DIGEST" "$SOURCE_WORKER" "$DESTINATION_WORKER"
rehearsal_log "both images are in production by digest. Deploy them with release-deploy.sh and the same two digests."
