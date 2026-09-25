#!/usr/bin/env bash
# The release manifest: one file that binds every artifact of a green full rehearsal
# (lane g74; audit O09).
#
#   infra/scripts/release-manifest.sh write <release-record.json> <out manifest> \
#       --checkout <commit> --run <id> --attempt <n> --run-url <url> --event <event> \
#       [--desktop-app-version <version>] \
#       [--pinned-commit <commit> --images-run <id> --images-commit <commit>]
#   infra/scripts/release-manifest.sh verify <manifest> <release-record.json>
#   infra/scripts/release-manifest.sh deployed <manifest> <out manifest> [--environment production] \
#       [--cluster <name>] [--api-service <name>] [--worker-service <name>]
#
# ## Why a second file
#
# The release record (`rehearsal-release-record.sh`, `fss.release-record.v1`) is what
# production stores and what the sending attestation names, and its contract is strict
# (`packages/contracts/src/release.ts`): a field added there is a record production
# refuses. It names two digests and a desktop stamp that the dispatch *said*. What it
# cannot say is which commit the suite ran, which run produced it, whether the images
# were the ones CI built for that commit's code, which desktop version goes with it, and
# — later — what production actually deployed. Before g74 matching those was a person
# reading four places. The manifest is written beside the record by the same workflow
# step sequence, carries the record's SHA-256 so neither can be swapped under the
# other, and is checked by `verify` rather than by eye.
#
# ## What `write` refuses
#
#   * a record that is not `fss.release-record.v1`, not `pass`, or whose digests are not
#     two different digests;
#   * a checkout that is not a full commit, a run id or attempt that is not a number;
#   * a **pinned** run (the weekly one, `--pinned-commit`) unless the checkout, the pin
#     and the record's desktop stamp are one commit, and unless it names the CI run and
#     commit its images came from, that commit is an ancestor of the checkout, and every
#     image input is byte-identical between the two (`release-images.sh inputs`). So a
#     weekly manifest proves the suite tested the code that is inside the images.
#
# A dispatched run's images came from whoever supplied the digests, so its manifest says
# `dispatch-input` and `inputsMatchCheckout: null` rather than claiming a match nobody
# checked.
#
# ## `deployed`, after the operator's production deploy
#
# Reads, and only reads, the two production services and the task definitions they run
# (`ecs describe-services`, `ecs describe-task-definition`) and refuses unless each
# container's image is the manifest's digest. What it writes is the manifest again with
# a `deployed` section naming both task definition ARNs and their digests. A mismatch
# writes nothing: a deployment that differs from its rehearsal is an incident to read,
# not a fact to file.
#
# Dry run: FSS_REHEARSAL_DRY_RUN=1 makes `deployed` print its reads and write nothing;
# `write` and `verify` touch local files only and behave the same either way. Offline
# seam: FSS_REHEARSAL_AWS_COMMAND (see `rehearsal-common.sh`).

# shellcheck source=infra/scripts/release-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-common.sh"

MANIFEST_SCHEMA='fss.release-manifest.v1'
IMAGES_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-images.sh"
MANIFEST_COMMIT_SHAPE='^[0-9a-f]{40}$'

manifest_fail() {
  echo "FAIL: $*" >&2
  exit 1
}

manifest_sha256() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

# ---------------------------------------------------------------------------
# write
# ---------------------------------------------------------------------------
subcommand_write() {
  local record=${1:-} out=${2:-}
  shift 2 2>/dev/null || manifest_fail "write needs <release-record.json> <out manifest>"
  local checkout='' run_id='' attempt='' run_url='' event='' app_version='' pinned='' images_run='' images_commit=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --checkout) checkout=${2:-} ;;
      --run) run_id=${2:-} ;;
      --attempt) attempt=${2:-} ;;
      --run-url) run_url=${2:-} ;;
      --event) event=${2:-} ;;
      --desktop-app-version) app_version=${2:-} ;;
      --pinned-commit) pinned=${2:-} ;;
      --images-run) images_run=${2:-} ;;
      --images-commit) images_commit=${2:-} ;;
      *) manifest_fail "write does not know '$1'" ;;
    esac
    shift 2 2>/dev/null || manifest_fail "$1 needs a value"
  done

  [ -s "$record" ] || manifest_fail "the release record '$record' is missing or empty; the manifest is written after it"
  [ -n "$out" ] || manifest_fail "write needs an output file"
  [[ "$checkout" =~ $MANIFEST_COMMIT_SHAPE ]] || manifest_fail "the checkout '$checkout' is not a full commit"
  [[ "$run_id" =~ ^[0-9]+$ ]] || manifest_fail "the run id '$run_id' is not a number"
  [[ "$attempt" =~ ^[0-9]+$ ]] || manifest_fail "the run attempt '$attempt' is not a number"
  case "$run_url" in https://*) ;; *) manifest_fail "the run URL '$run_url' is not https" ;; esac
  [[ "$event" =~ ^[a-z_]+$ ]] || manifest_fail "the event '$event' is not a GitHub event name"
  if [ -n "$app_version" ] && [[ ! "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    manifest_fail "the desktop app version '$app_version' is not major.minor.patch"
  fi

  local inputs_match='null' source='dispatch-input'
  if [ -n "$pinned" ] || [ -n "$images_run" ] || [ -n "$images_commit" ]; then
    [[ "$images_run" =~ ^[0-9]+$ ]] || manifest_fail "the images run '$images_run' is not a number; a manifest that names CI images names the run that built them"
    [[ "$images_commit" =~ $MANIFEST_COMMIT_SHAPE ]] || manifest_fail "the images commit '$images_commit' is not a full commit"
    git cat-file -e "${images_commit}^{commit}" 2>/dev/null && git cat-file -e "${checkout}^{commit}" 2>/dev/null \
      || manifest_fail "this checkout does not hold both $images_commit and $checkout, so it cannot compare their image inputs (fetch-depth: 0)"
    git merge-base --is-ancestor "$images_commit" "$checkout" \
      || manifest_fail "the images were built at $images_commit, which is not an ancestor of the checkout $checkout"
    local inputs=()
    while IFS= read -r line; do inputs+=("$line"); done < <("$IMAGES_SCRIPT" inputs)
    [ "${#inputs[@]}" -gt 0 ] || manifest_fail "release-images.sh named no image inputs"
    git diff --quiet "$images_commit" "$checkout" -- "${inputs[@]}" \
      || manifest_fail "the image inputs differ between $images_commit and $checkout; the images are not the code the suite tested"
    inputs_match='true'
    source='ci'
  fi
  if [ -n "$pinned" ]; then
    [ "$pinned" = "$checkout" ] || manifest_fail "the run was pinned to $pinned and checked out $checkout"
  fi

  mkdir -p "$(dirname "$out")"
  FSS_RECORD="$record" FSS_RECORD_SHA256="$(manifest_sha256 "$record")" FSS_CHECKOUT="$checkout" \
  FSS_RUN_ID="$run_id" FSS_ATTEMPT="$attempt" FSS_RUN_URL="$run_url" FSS_EVENT="$event" \
  FSS_APP_VERSION="$app_version" FSS_PINNED="$pinned" FSS_SOURCE="$source" FSS_IMAGES_RUN="$images_run" \
  FSS_IMAGES_COMMIT="$images_commit" FSS_INPUTS_MATCH="$inputs_match" \
  FSS_RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" FSS_SCHEMA="$MANIFEST_SCHEMA" \
    python3 - > "$out.partial" <<'PY' || { rm -f "$out.partial"; exit 1; }
# release-manifest-write
import json, os, re, sys

env = os.environ

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

try:
    record = json.load(open(env["FSS_RECORD"], encoding="utf-8"))
except (OSError, ValueError) as error:
    fail("the release record does not parse: {}".format(error))
if not isinstance(record, dict) or record.get("schema") != "fss.release-record.v1":
    fail("the release record is not fss.release-record.v1")
if record.get("suite") != "pass":
    fail("the release record's suite is '{}'; a manifest is only written for a green suite".format(record.get("suite")))
artifacts = record.get("artifacts") or {}
digest = re.compile(r"^sha256:[0-9a-f]{64}$")
for service in ("api", "worker"):
    if not isinstance(artifacts.get(service), str) or not digest.match(artifacts[service]):
        fail("the release record's {} artifact is not an image digest".format(service))
if artifacts["api"] == artifacts["worker"]:
    fail("the release record names one image under both names")
stamp = artifacts.get("desktopCommitStamp")
if not isinstance(stamp, str) or not stamp.strip():
    fail("the release record names no desktop commit stamp")
reference = record.get("releaseGateReference")
if not isinstance(reference, str) or not reference:
    fail("the release record has no releaseGateReference")

checkout = env["FSS_CHECKOUT"]
pinned = env["FSS_PINNED"]
if pinned and stamp != checkout:
    fail("a pinned run's desktop commit stamp must be its checkout: the record says {}, the checkout is {}".format(stamp, checkout))

source = env["FSS_SOURCE"]
print(json.dumps({
    "schema": env["FSS_SCHEMA"],
    "releaseGateReference": reference,
    "recordedAt": env["FSS_RECORDED_AT"],
    "releaseRecord": {
        "file": "release-record.json",
        "sha256": env["FSS_RECORD_SHA256"],
        "releaseGateReference": reference,
        "rehearsalPrefix": record.get("rehearsalPrefix"),
        "recordedAt": record.get("recordedAt"),
        "suite": record.get("suite"),
        "carryDrill": record.get("carryDrill"),
    },
    "checkout": {"commit": checkout},
    "run": {
        "id": env["FSS_RUN_ID"],
        "attempt": env["FSS_ATTEMPT"],
        "url": env["FSS_RUN_URL"],
        "event": env["FSS_EVENT"],
        "trigger": "weekly" if pinned else "dispatch",
    },
    "pinned": bool(pinned),
    "images": {
        "api": {"repository": "fss-rh-api", "digest": artifacts["api"]},
        "worker": {"repository": "fss-rh-worker", "digest": artifacts["worker"]},
        "provenance": {
            "source": source,
            "workflowRunId": env["FSS_IMAGES_RUN"] or None,
            "commit": env["FSS_IMAGES_COMMIT"] or None,
            "inputsMatchCheckout": True if env["FSS_INPUTS_MATCH"] == "true" else None,
        },
    },
    "desktop": {
        "commitStamp": stamp,
        "stampIsCheckout": stamp == checkout,
        "appVersion": env["FSS_APP_VERSION"] or None,
    },
    "deployed": None,
}, indent=2))
PY
  mv "$out.partial" "$out"
  rehearsal_log "wrote the release manifest for $(release_json_path "$(cat "$out")" releaseGateReference) to $out"
}

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------
subcommand_verify() {
  local manifest=${1:-} record=${2:-}
  [ -s "$manifest" ] || manifest_fail "the manifest '$manifest' is missing or empty"
  [ -s "$record" ] || manifest_fail "the release record '$record' is missing or empty"
  FSS_MANIFEST="$manifest" FSS_RECORD="$record" FSS_RECORD_SHA256="$(manifest_sha256 "$record")" \
  FSS_SCHEMA="$MANIFEST_SCHEMA" python3 - <<'PY'
# release-manifest-verify
import json, os, re, sys

env = os.environ
problems = []

def load(path, what):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError) as error:
        print("FAIL: the {} does not parse: {}".format(what, error), file=sys.stderr)
        sys.exit(1)

manifest = load(env["FSS_MANIFEST"], "manifest")
record = load(env["FSS_RECORD"], "release record")
if manifest.get("schema") != env["FSS_SCHEMA"]:
    problems.append("the manifest is not {}".format(env["FSS_SCHEMA"]))
bound = manifest.get("releaseRecord") or {}
if bound.get("sha256") != env["FSS_RECORD_SHA256"]:
    problems.append("the release record is not the file this manifest was written for (SHA-256 differs)")
reference = record.get("releaseGateReference")
if manifest.get("releaseGateReference") != reference or bound.get("releaseGateReference") != reference:
    problems.append("the manifest names release gate {}, the record {}".format(manifest.get("releaseGateReference"), reference))
if record.get("suite") != "pass" or bound.get("suite") != "pass":
    problems.append("the record's suite is not pass")
artifacts = record.get("artifacts") or {}
images = manifest.get("images") or {}
digest = re.compile(r"^sha256:[0-9a-f]{64}$")
for service in ("api", "worker"):
    named = (images.get(service) or {}).get("digest")
    if not isinstance(named, str) or not digest.match(named):
        problems.append("the manifest's {} digest is not a digest".format(service))
    elif named != artifacts.get(service):
        problems.append("the manifest's {} digest {} is not the record's {}".format(service, named, artifacts.get(service)))
desktop = manifest.get("desktop") or {}
if desktop.get("commitStamp") != artifacts.get("desktopCommitStamp"):
    problems.append("the manifest's desktop stamp is not the record's")
checkout = (manifest.get("checkout") or {}).get("commit")
if not isinstance(checkout, str) or not re.match(r"^[0-9a-f]{40}$", checkout):
    problems.append("the manifest names no checkout commit")
if desktop.get("stampIsCheckout") is not (desktop.get("commitStamp") == checkout):
    problems.append("the manifest's stampIsCheckout does not match its own stamp and checkout")
provenance = images.get("provenance") or {}
if manifest.get("pinned") is True:
    if desktop.get("commitStamp") != checkout:
        problems.append("a pinned manifest's desktop stamp is not its checkout")
    if provenance.get("source") != "ci" or provenance.get("inputsMatchCheckout") is not True:
        problems.append("a pinned manifest does not prove its images are the checkout's code")
    if (manifest.get("run") or {}).get("trigger") != "weekly":
        problems.append("a pinned manifest does not say it was the weekly run")
elif manifest.get("pinned") is not False:
    problems.append("the manifest does not say whether it was pinned")
deployed = manifest.get("deployed")
if deployed is not None:
    for service in ("api", "worker"):
        entry = (deployed or {}).get(service) or {}
        if entry.get("digest") != (images.get(service) or {}).get("digest"):
            problems.append("production runs a different {} image than the manifest names".format(service))
if problems:
    for problem in problems:
        print("FAIL: " + problem, file=sys.stderr)
    sys.exit(1)
print("the manifest binds release gate {}: checkout {}, api {}, worker {}, desktop {}{}".format(
    reference, checkout, artifacts["api"], artifacts["worker"], desktop.get("commitStamp"),
    ", deployed" if deployed is not None else ""))
PY
}

# ---------------------------------------------------------------------------
# deployed
# ---------------------------------------------------------------------------
subcommand_deployed() {
  local manifest=${1:-} out=${2:-}
  shift 2 2>/dev/null || manifest_fail "deployed needs <manifest> <out manifest>"
  local environment='production' prefix='fss-prod' cluster='' api_service='' worker_service=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --environment) environment=${2:-} ;;
      --cluster) cluster=${2:-} ;;
      --api-service) api_service=${2:-} ;;
      --worker-service) worker_service=${2:-} ;;
      *) manifest_fail "deployed does not know '$1'" ;;
    esac
    shift 2 2>/dev/null || manifest_fail "$1 needs a value"
  done
  # A rehearsal's own environment is destroyed before its manifest exists; the only
  # deployment a manifest can later describe is production's.
  [ "$environment" = production ] || manifest_fail "deployed records a production deployment only, not '$environment'"
  cluster=${cluster:-${prefix}-cluster}
  api_service=${api_service:-${prefix}-api}
  worker_service=${worker_service:-${prefix}-worker}
  for name in "$cluster" "$api_service" "$worker_service"; do
    case "$name" in
      "$prefix"-*) ;;
      *) manifest_fail "'$name' is not in the production namespace" ;;
    esac
  done
  [ -s "$manifest" ] || manifest_fail "the manifest '$manifest' is missing or empty"
  [ -n "$out" ] || manifest_fail "deployed needs an output file"

  local work service name described definition_arn definition found=''
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-deployed.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now; the local is gone by the time EXIT runs
  trap "rm -rf '$work'" EXIT
  for service in api worker; do
    name=$api_service
    [ "$service" = worker ] && name=$worker_service
    if rehearsal_dry_run; then
      release_aws "$environment" ecs describe-services --cluster "$cluster" --services "$name" --output json
      release_aws "$environment" ecs describe-task-definition --task-definition "<the taskDefinition of $name>" \
        --query taskDefinition --output json
      continue
    fi
    described="$(release_aws "$environment" ecs describe-services --cluster "$cluster" --services "$name" --output json)" \
      || manifest_fail "ECS did not describe $name"
    definition_arn="$(FSS_JSON="$described" FSS_NAME="$name" python3 -c '
import json, os, sys
answer = json.loads(os.environ["FSS_JSON"] or "{}") or {}
for entry in answer.get("services") or []:
    if entry.get("serviceName") == os.environ["FSS_NAME"]:
        if entry.get("status") != "ACTIVE":
            print("FAIL: {} is {}, not ACTIVE".format(os.environ["FSS_NAME"], entry.get("status")), file=sys.stderr)
            sys.exit(1)
        print(entry.get("taskDefinition") or "")
        sys.exit(0)
print("FAIL: ECS does not describe a service named {}".format(os.environ["FSS_NAME"]), file=sys.stderr)
sys.exit(1)
')" || exit 1
    case "$definition_arn" in
      arn:aws*:ecs:*:task-definition/"$prefix"-*:[0-9]*) ;;
      *) manifest_fail "$name runs '$definition_arn', which is not a production task definition" ;;
    esac
    definition="$(release_aws "$environment" ecs describe-task-definition --task-definition "$definition_arn" \
      --query taskDefinition --output json)" || manifest_fail "ECS did not describe $definition_arn"
    printf '%s' "$definition" > "$work/$service-definition.json"
    printf '%s' "$definition_arn" > "$work/$service-arn.txt"
    found=yes
  done
  if rehearsal_dry_run; then
    rehearsal_plan "refuse unless each service's container image is the manifest's digest; write $out"
    return 0
  fi
  [ -n "$found" ] || manifest_fail "nothing was read"

  FSS_MANIFEST="$manifest" FSS_WORK="$work" FSS_CLUSTER="$cluster" FSS_API_SERVICE="$api_service" \
  FSS_WORKER_SERVICE="$worker_service" FSS_RECORDED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  python3 - > "$out.partial" <<'PY' || { rm -f "$out.partial"; exit 1; }
# release-manifest-deployed
import json, os, sys

env = os.environ
manifest = json.load(open(env["FSS_MANIFEST"], encoding="utf-8"))
if manifest.get("schema") != "fss.release-manifest.v1":
    print("FAIL: the manifest is not fss.release-manifest.v1", file=sys.stderr)
    sys.exit(1)
deployed = {
    "environment": "production",
    "recordedAt": env["FSS_RECORDED_AT"],
    "cluster": env["FSS_CLUSTER"],
}
problems = []
for service, name in (("api", env["FSS_API_SERVICE"]), ("worker", env["FSS_WORKER_SERVICE"])):
    arn = open(os.path.join(env["FSS_WORK"], service + "-arn.txt"), encoding="utf-8").read().strip()
    definition = json.load(open(os.path.join(env["FSS_WORK"], service + "-definition.json"), encoding="utf-8"))
    image = ""
    for container in definition.get("containerDefinitions") or []:
        if container.get("name") == service:
            image = str(container.get("image") or "")
    digest = image.rpartition("@")[2] if "@" in image else ""
    expected = ((manifest.get("images") or {}).get(service) or {}).get("digest")
    if not digest:
        problems.append("{} runs {} whose {} container names no digest ('{}')".format(name, arn, service, image))
    elif digest != expected:
        problems.append("{} runs {} with {}, and the manifest names {}".format(name, arn, digest, expected))
    deployed[service] = {"service": name, "taskDefinition": arn, "digest": digest}
if problems:
    for problem in problems:
        print("FAIL: " + problem, file=sys.stderr)
    print("FAIL: production does not run what this manifest rehearsed; nothing was written", file=sys.stderr)
    sys.exit(1)
deployed["matchesManifest"] = True
manifest["deployed"] = deployed
print(json.dumps(manifest, indent=2))
PY
  mv "$out.partial" "$out"
  rehearsal_log "production runs the manifest's digests; wrote $out"
}

SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  write) subcommand_write "$@" ;;
  verify) subcommand_verify "$@" ;;
  deployed) subcommand_deployed "$@" ;;
  *)
    echo "usage: $(basename "$0") write <record> <out> --checkout <sha> --run <id> --attempt <n> --run-url <url> --event <event> [...] | verify <manifest> <record> | deployed <manifest> <out> [...]" >&2
    exit 2
    ;;
esac
