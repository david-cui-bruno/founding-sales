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
#   2. if `fss-prod-<image>` already holds that digest under a tag, nothing is copied —
#      running this twice is running it once. Held under no tag, it is tagged in place
#      (below);
#   3. otherwise the tag must not already name a different digest in production (the
#      repositories are IMMUTABLE, and a tag somebody pushed from a laptop is not
#      overwritten by a copy);
#   4. `docker buildx imagetools create --tag <prod>:<tag> --prefer-index=false
#      <rh>@<digest>` copies the manifest and its blobs registry-to-registry — the
#      operator convention of `fss-prod-images.sh` — so nothing is rebuilt and nothing
#      passes through the Mac's image store;
#   5. production is read back and the tag must name the same digest. That comparison is
#      the point: the digest production deploys is the digest that passed.
#
# ## A bare manifest is not an index (lane g86)
#
# The images workflow's `publish` job pushes each image as a bare
# `application/vnd.oci.image.manifest.v1+json`. Given one such source, `imagetools
# create` by default wraps it in a new index: it pushes the manifest itself by digest and
# puts the tag on the wrapper, whose digest is another one. That is what refused the
# promotion of e220f468 on 25 September (the API's 87730328… came back as 7abeaab5…).
# `--prefer-index=false` asks for a carbon copy instead, so the tag names the source
# digest whichever shape it has. If the read-back still differs, the copy is not trusted
# and not undone: the source digest must now be in the destination, or this fails naming
# both, and then that exact manifest is tagged where it is (`tag_in_place`) and read back
# again. A digest that is in production with no tag at all — the child an earlier
# wrapping copy left behind — is tagged the same way, because the lifecycle policy
# expires untagged images and a running task definition names that digest.
#
# The tag it gets is the release's own when that is free, else `<tag>-image`: the
# repositories are IMMUTABLE, and after a wrapping copy the release's tag is the
# wrapper's. Either way the script prints which, and a candidate already naming another
# digest is passed over, never overwritten.
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
# Every one is a read but `put-image`, and that one may only name a production
# repository: it tags a manifest that is already there (see `tag_in_place`).
#   promote_aws <describe-images|describe-repositories|batch-get-image|put-image> <repository> [argument...]
promote_aws() {
  local operation=$1 repository=$2
  shift 2
  case "$operation" in
    describe-images | describe-repositories | batch-get-image) ;;
    put-image)
      case " $PROMOTE_DESTINATIONS " in
        *" $repository "*) ;;
        *) promote_fail "put-image may only tag a production repository, not '$repository'" ;;
      esac
      ;;
    *) promote_fail "this script may only read ECR and tag a production image, not '$operation'" ;;
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

# The manifest media type ECR records for a digest. Only the four image shapes are known.
media_type_of() {
  local repository=$1 digest=$2 output
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageManifestMediaType' --output text)" \
    || promote_fail "could not read the manifest type of $repository@$digest"
  case "$output" in
    application/vnd.oci.image.manifest.v1+json | application/vnd.docker.distribution.manifest.v2+json \
      | application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json)
      printf '%s' "$output"
      ;;
    *) promote_fail "$repository@$digest is a '$output', which is not an image manifest or index" ;;
  esac
}

# One tag that names a digest in a repository, or nothing when it has none.
tag_of_digest() {
  local repository=$1 digest=$2 output
  output="$(promote_aws describe-images "$repository" --image-ids "imageDigest=$digest" \
    --query 'imageDetails[0].imageTags[0]' --output text)" \
    || promote_fail "could not read the tags of $repository@$digest"
  [ "$output" = None ] || printf '%s' "$output"
}

# Tag a digest that is already in a production repository, by its own bytes: the
# manifest `batch-get-image` returns as stored, put back under a tag with
# `--image-digest`, which ECR refuses unless those bytes are that digest. Prints the
# tag. Logs go to stderr, because the caller reads stdout.
tag_in_place() {
  local repository=$1 digest=$2 media_type=$3 tag='' candidate holder work
  for candidate in "$TAG" "$TAG-image"; do
    [ "${#candidate}" -le 128 ] || continue
    holder="$(digest_of_tag "$repository" "$candidate")"
    if [ -z "$holder" ] || [ "$holder" = None ]; then
      tag=$candidate
      break
    fi
    if [ "$holder" = "$digest" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    rehearsal_log "$repository:$candidate already names $holder; not that one" >&2
  done
  [ -n "$tag" ] || promote_fail "$repository has no free tag for $digest: $TAG and $TAG-image both name other images; name another with --tag"

  work="$(mktemp -d)"
  if ! promote_aws batch-get-image "$repository" --image-ids "imageDigest=$digest" \
      --accepted-media-types "$media_type" --output json >"$work/image.json"; then
    rm -rf "$work"
    promote_fail "could not read the manifest of $repository@$digest"
  fi
  if ! FSS_IMAGE="$work/image.json" FSS_MANIFEST="$work/manifest.json" FSS_DIGEST="$digest" python3 - <<'PY'
# release-promote-manifest
import json, os, sys
images = (json.load(open(os.environ["FSS_IMAGE"], encoding="utf-8")) or {}).get("images") or []
if len(images) != 1 or (images[0].get("imageId") or {}).get("imageDigest") != os.environ["FSS_DIGEST"]:
    sys.exit("ECR did not return exactly the image asked for")
with open(os.environ["FSS_MANIFEST"], "w", encoding="utf-8", newline="") as handle:
    handle.write(images[0]["imageManifest"])
PY
  then
    rm -rf "$work"
    promote_fail "ECR did not return the manifest of $repository@$digest"
  fi
  if ! promote_aws put-image "$repository" --image-tag "$tag" --image-digest "$digest" \
      --image-manifest "file://$work/manifest.json" --image-manifest-media-type "$media_type" >/dev/null; then
    rm -rf "$work"
    promote_fail "could not tag $repository@$digest as $tag"
  fi
  rm -rf "$work"
  holder="$(digest_of_tag "$repository" "$tag")"
  [ "$holder" = "$digest" ] || promote_fail "$repository:$tag is ${holder:-<nothing>} after tagging $digest in place; the digest still differs"
  printf '%s' "$tag"
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
  local source_repository="fss-rh-$service" destination_repository="fss-prod-$service" presence existing copied media_type held tagged
  if rehearsal_dry_run; then
    promote_aws describe-images "$source_repository" --image-ids "imageDigest=$digest"
    rehearsal_plan "refuse unless $source_repository holds $digest, and read its manifest type"
    promote_aws describe-images "$destination_repository" --image-ids "imageDigest=$digest"
    rehearsal_plan "stop here if $destination_repository already holds $digest under a tag; tag it in place if it holds it under none"
    promote_aws describe-images "$destination_repository" --image-ids "imageTag=$TAG"
    rehearsal_plan "refuse if $destination_repository:$TAG names another digest"
    promote_docker buildx imagetools create --tag "$destination_uri:$TAG" --prefer-index=false "$source_uri@$digest"
    promote_aws describe-images "$destination_repository" --image-ids "imageTag=$TAG"
    rehearsal_plan "if $destination_repository:$TAG is not $digest: refuse unless $destination_repository now holds $digest, then batch-get-image and put-image it under $TAG or $TAG-image, and read that tag back"
    return 0
  fi

  presence="$(digest_presence "$source_repository" "$digest")"
  [ "$presence" = present ] || promote_fail "$source_repository has no image $digest; nothing to promote (expired, or never published)"
  media_type="$(media_type_of "$source_repository" "$digest")"

  presence="$(digest_presence "$destination_repository" "$digest")"
  if [ "$presence" = present ]; then
    held="$(tag_of_digest "$destination_repository" "$digest")"
    if [ -n "$held" ]; then
      rehearsal_log "$destination_repository already holds $digest as $held; nothing to copy"
      echo "$service $destination_repository $digest already-present"
      return 0
    fi
    # The child an earlier wrapping copy pushed by digest and never tagged.
    tagged="$(tag_in_place "$destination_repository" "$digest" "$media_type")"
    rehearsal_log "$destination_repository held $digest under no tag; it is $tagged now"
    echo "$service $destination_repository $digest tagged-in-place $tagged"
    return 0
  fi

  existing="$(digest_of_tag "$destination_repository" "$TAG")"
  if [ -n "$existing" ] && [ "$existing" != "None" ] && [ "$existing" != "$digest" ]; then
    promote_fail "$destination_repository:$TAG already names $existing; tags are immutable, so name another with --tag"
  fi

  # A carbon copy, index or bare manifest alike; see "A bare manifest is not an index".
  promote_docker buildx imagetools create --tag "$destination_uri:$TAG" --prefer-index=false "$source_uri@$digest" >/dev/null

  copied="$(digest_of_tag "$destination_repository" "$TAG")"
  if [ "$copied" != "$digest" ]; then
    [ "$(digest_presence "$destination_repository" "$digest")" = present ] \
      || promote_fail "$destination_repository:$TAG is ${copied:-<nothing>}, and the release is $digest: the digest changed in the copy, and $digest itself is not in $destination_repository"
    rehearsal_log "$destination_repository:$TAG is ${copied:-<nothing>}, an index around $digest; tagging $digest itself"
    tagged="$(tag_in_place "$destination_repository" "$digest" "$media_type")"
    rehearsal_log "$destination_repository:$tagged = $digest, the digest that passed ($TAG names the wrapper)"
    echo "$service $destination_repository $digest copied-and-tagged $tagged"
    return 0
  fi
  rehearsal_log "$destination_repository:$TAG = $digest, the digest that passed"
  echo "$service $destination_repository $digest copied"
}

promote_one api "$API_DIGEST" "$SOURCE_API" "$DESTINATION_API"
promote_one worker "$WORKER_DIGEST" "$SOURCE_WORKER" "$DESTINATION_WORKER"
rehearsal_log "both images are in production by digest. Deploy them with release-deploy.sh and the same two digests."
