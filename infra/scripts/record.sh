#!/usr/bin/env bash
# The release record (P7, 26 September 2026): build it from the CI gate, store it before
# the rollout, read it back after.
#
#   infra/scripts/record.sh from-ci <gate run id> <commit> <api digest> <worker digest> \
#       [--enables-sending] [--out <file>]
#   infra/scripts/record.sh put       <root> <prefix> --api-digest D --worker-digest D --release-record <file>
#   infra/scripts/record.sh read-back <root> <prefix> --api-digest D --worker-digest D --release-record <file> \
#       [--allow-created]
#
# The worker sends only while a stored record names its own image digest, so a release
# stores the record BEFORE the plan and apply (`put`): a put after the rollout would leave
# every new worker task that starts during it without one (`release_record_unknown`).
# `read-back` is the separate check after the rollout: the same put again, which must
# answer `existing`. Both run `fss admin release-record put` on the operations task
# definition the root outputs now, held to that definition's own worker image (before the
# apply that is the running release's image; the record names the new digests).
#
# from-ci reads GitHub only (`gh`, or FSS_GH_COMMAND; GITHUB_REPOSITORY or the checkout's
# remote): the gate run must be a green push to main of `.github/workflows/greenfield.yml`
# (by path, never display name) at <commit>; the newest push run of greenfield-images.yml
# at <commit> must be green and its `fss-image-digests` artifact must name exactly the two
# digests. A commit that changed no image input has no images run of its own: record the
# images commit `images.sh pin` names, with that commit's gate run. It writes
# `fss.release-record.v1` with `source: "ci-gate"`, `recordedAt` = the gate run's
# `updated_at` (so a rebuild is byte-identical and a second put answers `existing`).
# Any mismatch is one `FAIL:` line on stderr, exit 1, and no file.
#
# Dry run (put and read-back): FSS_REHEARSAL_DRY_RUN=1 prints every call.

# shellcheck source=infra/scripts/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

record_usage() {
  echo "usage: record.sh from-ci <gate run id> <commit> <api digest> <worker digest> [--enables-sending] [--out <file>]" >&2
  echo "       record.sh put|read-back <root> <prefix> --api-digest D --worker-digest D --release-record <file> [--allow-created]" >&2
  exit 2
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# from-ci
# ---------------------------------------------------------------------------
record_from_ci() {
  local enables_sending=false out='' repo_path='{owner}/{repo}' work images_run_id reference
  local -a positional=() repo_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --enables-sending) enables_sending=true; shift ;;
      --out) [ "$#" -ge 2 ] || record_usage; out=$2; shift 2 ;;
      --*) fail "record.sh from-ci does not take '$1'" ;;
      *) positional+=("$1"); shift ;;
    esac
  done
  [ "${#positional[@]}" -eq 4 ] || record_usage
  local gate_run_id=${positional[0]} commit=${positional[1]} api=${positional[2]} worker=${positional[3]} digest
  [[ "$gate_run_id" =~ ^[1-9][0-9]{0,19}$ ]] || fail "the gate run id '$gate_run_id' is not a GitHub Actions run id"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail "the commit '$commit' is not a full forty-character commit"
  for digest in "$api" "$worker"; do
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || fail "'$digest' is not an image digest (sha256:<64 hex>). The record names images, and a tag is mutable."
  done
  [ "$api" != "$worker" ] || fail "the API and worker digests are identical; one image was pushed under both names"
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    [[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GITHUB_REPOSITORY '$GITHUB_REPOSITORY' is not owner/name"
    repo_args=(--repo "$GITHUB_REPOSITORY")
    repo_path=$GITHUB_REPOSITORY
  fi

  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-ci-record.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$work'" EXIT
  command "${FSS_GH_COMMAND:-gh}" api "repos/$repo_path/actions/runs/$gate_run_id" > "$work/gate.json" 2> "$work/gate.err" \
    || fail "gh could not read run $gate_run_id: $(head -n 1 "$work/gate.err")"
  command "${FSS_GH_COMMAND:-gh}" api "repos/$repo_path/actions/workflows/greenfield-images.yml/runs?head_sha=$commit&event=push&branch=main&per_page=20" \
    > "$work/images-runs.json" 2> "$work/images.err" \
    || fail "gh could not list the Greenfield images runs of $commit: $(head -n 1 "$work/images.err")"

  images_run_id="$(FSS_WORK="$work" FSS_GATE_RUN_ID="$gate_run_id" FSS_COMMIT="$commit" FSS_REPOSITORY="${GITHUB_REPOSITORY:-}" python3 - <<'PY'
import json, os, re, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

env = os.environ
work, run_id, commit = env["FSS_WORK"], env["FSS_GATE_RUN_ID"], env["FSS_COMMIT"]
GATE, IMAGES = ".github/workflows/greenfield.yml", ".github/workflows/greenfield-images.yml"

def path(run):
    return str(run.get("path", "")).split("@")[0]

try:
    gate = json.load(open(os.path.join(work, "gate.json"), encoding="utf-8"))
except ValueError:
    fail("gh's answer for run {} is not JSON".format(run_id))
if not isinstance(gate, dict):
    fail("gh's answer for run {} is not a run".format(run_id))
if str(gate.get("id")) != run_id:
    fail("gh answered for run {}, not {}".format(gate.get("id"), run_id))
if path(gate) != GATE:
    fail("run {} is a run of '{}' (named '{}'), not of {}, the Greenfield gate workflow".format(run_id, gate.get("path"), gate.get("name"), GATE))
if gate.get("status") != "completed" or gate.get("conclusion") != "success":
    fail("gate run {} is {}/{}, not completed/success".format(run_id, gate.get("status"), gate.get("conclusion")))
if gate.get("head_sha") != commit:
    fail("gate run {} ran on {}, not {}".format(run_id, gate.get("head_sha"), commit))
if gate.get("event") != "push" or gate.get("head_branch") != "main":
    fail("gate run {} is a {} on {}, not a push to main".format(run_id, gate.get("event"), gate.get("head_branch")))
url = str(gate.get("html_url", ""))
match = re.match(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/runs/([0-9]+)$", url)
if not match or match.group(2) != run_id:
    fail("gate run {} has the URL '{}', which is not its own run page".format(run_id, url))
repository = match.group(1)
if env["FSS_REPOSITORY"] and repository != env["FSS_REPOSITORY"]:
    fail("gate run {} is in {}, not {}".format(run_id, repository, env["FSS_REPOSITORY"]))
if (gate.get("head_repository") or {}).get("full_name") != repository:
    fail("gate run {} built {}'s commit, not {}'s".format(run_id, (gate.get("head_repository") or {}).get("full_name"), repository))
updated = str(gate.get("updated_at", ""))
if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$", updated):
    fail("gate run {} reports updated_at '{}', which is not a UTC instant".format(run_id, updated))

try:
    listed = json.load(open(os.path.join(work, "images-runs.json"), encoding="utf-8"))
except ValueError:
    fail("gh's list of Greenfield images runs is not JSON")
if not isinstance(listed, dict) or not isinstance(listed.get("workflow_runs"), list):
    fail("gh's list of Greenfield images runs is not a list of runs")
runs = [run for run in listed["workflow_runs"] if isinstance(run, dict) and path(run) == IMAGES
        and run.get("head_sha") == commit and run.get("event") == "push" and run.get("head_branch") == "main"
        and (run.get("head_repository") or {}).get("full_name") == repository
        and re.match(r"^[1-9][0-9]{0,19}$", str(run.get("id", "")))]
if not runs:
    fail("no Greenfield images run pushed to main at {}; a commit that changed no image input has the images of the last one that did (images.sh pin names it), so record that commit".format(commit))
runs.sort(key=lambda run: (str(run.get("created_at", "")), int(run["id"])), reverse=True)
images = runs[0]
images_id = str(images["id"])
if images.get("status") != "completed" or images.get("conclusion") != "success":
    fail("the Greenfield images run {} for {} is {}/{}, not completed/success".format(images_id, commit, images.get("status"), images.get("conclusion")))
if not str(images.get("html_url", "")).startswith("https://github.com/{}/actions/runs/".format(repository)):
    fail("the Greenfield images run {} is in another repository than gate run {}".format(images_id, run_id))
if images_id == run_id:
    fail("the images run and the gate run are the same run, {}".format(run_id))
json.dump({"url": url, "updatedAt": updated}, open(os.path.join(work, "gate-facts.json"), "w", encoding="utf-8"))
print(images_id)
PY
)" || exit 1

  mkdir -p "$work/artifact"
  command "${FSS_GH_COMMAND:-gh}" run download "$images_run_id" ${repo_args[@]+"${repo_args[@]}"} --name fss-image-digests --dir "$work/artifact" \
    > /dev/null 2> "$work/download.err" \
    || fail "images run $images_run_id has no fss-image-digests artifact gh could download: $(head -n 1 "$work/download.err")"

  FSS_WORK="$work" FSS_COMMIT="$commit" FSS_GATE_RUN_ID="$gate_run_id" FSS_IMAGES_RUN_ID="$images_run_id" \
    FSS_API="$api" FSS_WORKER="$worker" FSS_ENABLES_SENDING="$enables_sending" python3 - > "$work/release-record.json" <<'PY' || exit 1
import json, os, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

env = os.environ
commit, images_id = env["FSS_COMMIT"], env["FSS_IMAGES_RUN_ID"]
try:
    document = json.load(open(os.path.join(env["FSS_WORK"], "artifact", "image-digests.json"), encoding="utf-8"))
except (OSError, ValueError):
    fail("the fss-image-digests artifact of images run {} holds no readable image-digests.json".format(images_id))
if not isinstance(document, dict) or document.get("schema") != "fss.image-digests.v1":
    fail("the digests of images run {} are not fss.image-digests.v1".format(images_id))
if document.get("commit") != commit:
    fail("the digests of images run {} name commit {}, not {}".format(images_id, document.get("commit"), commit))
if str(document.get("workflowRunId")) != images_id:
    fail("the digests of images run {} name run {}".format(images_id, document.get("workflowRunId")))
images = document.get("images") if isinstance(document.get("images"), dict) else {}
for service, given in (("api", env["FSS_API"]), ("worker", env["FSS_WORKER"])):
    entry = images.get(service) if isinstance(images.get(service), dict) else {}
    if entry.get("repository") != "fss-rh-" + service or entry.get("tag") != "ci-" + commit:
        fail("the {} image of images run {} is {}:{}, not fss-rh-{}:ci-{}".format(service, images_id, entry.get("repository"), entry.get("tag"), service, commit))
    if entry.get("digest") != given:
        fail("images run {} published the {} digest {}, not {}".format(images_id, service, entry.get("digest"), given))
gate = json.load(open(os.path.join(env["FSS_WORK"], "gate-facts.json"), encoding="utf-8"))
run_id = env["FSS_GATE_RUN_ID"]
print(json.dumps({
    "schema": "fss.release-record.v1",
    "source": "ci-gate",
    "releaseGateReference": "ci-gate-{}-{}".format(run_id, commit[:12]),
    "recordedAt": gate["updatedAt"],
    "suite": "pass",
    "commit": commit,
    "gateRunId": run_id,
    "gateRunUrl": gate["url"],
    "imagesRunId": images_id,
    "artifacts": {"api": env["FSS_API"], "worker": env["FSS_WORKER"], "desktopCommitStamp": commit},
    "enablesSending": env["FSS_ENABLES_SENDING"] == "true",
}, indent=2))
PY

  reference="ci-gate-${gate_run_id}-${commit:0:12}"
  if [ -n "$out" ]; then
    mkdir -p "$(dirname "$out")"
    cp "$work/release-record.json" "$out.partial"
    mv "$out.partial" "$out"
    rehearsal_log "release record $reference (ci-gate, gate run $gate_run_id, images run $images_run_id, enablesSending=$enables_sending) written to $out" >&2
  else
    cat "$work/release-record.json"
  fi
}

# ---------------------------------------------------------------------------
# put and read-back
# ---------------------------------------------------------------------------
record_store() {
  local stage=$1 root=${2:-} prefix=${3:-} api='' worker='' file='' allow_created=0 digest
  shift 3 2>/dev/null || record_usage
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --api-digest) api=${2:-}; shift 2 ;;
      --worker-digest) worker=${2:-}; shift 2 ;;
      --release-record) file=${2:-}; shift 2 ;;
      --allow-created) allow_created=1; shift ;;
      *) fail "record.sh $stage does not take '$1'" ;;
    esac
  done
  [ -n "$root" ] && [ -n "$prefix" ] || record_usage
  [ -n "$file" ] || fail "record.sh $stage stores a release record, so it needs --release-record <file>."
  [ -n "$api" ] && [ -n "$worker" ] \
    || fail "record.sh $stage needs --api-digest and --worker-digest: the record must name exactly the release it is stored for."
  for digest in "$api" "$worker"; do
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "'$digest' is not an image digest (sha256:<64 hex>)."
  done
  # The file, and that it names these two digests, before anything is asked.
  release_record_base64 "$file" "$api" "$worker" > /dev/null || exit 1

  local environment
  environment="$(release_environment_for_prefix "$prefix")" || exit 1
  case "$environment:$root" in
    production:*roots/production | rehearsal:*roots/rehearsal) ;;
    *) fail "prefix '$prefix' is a $environment prefix and '$root' is not the $environment root." ;;
  esac

  local cluster operations secret network_plan log_group plan host account region
  cluster="$(release_output "$root" cluster_arn)"
  operations="$(release_output "$root" operations_task_definition_arn)"
  secret="$(release_output "$root" app_runtime_database_secret_arn)"
  network_plan="$(release_output "$root" task_network_configuration json)"
  log_group="$(release_output "$root" worker_log_group_name)"
  plan="$(release_output "$root" deployment_plan json)"
  host="$(release_json_path "${network_plan:-}" "database_host")"
  account="${FSS_RELEASE_ACCOUNT:-$(release_caller_account)}"
  region="${AWS_REGION:-us-east-1}"
  if [ "$(release_json_path "${plan:-}" "bootstrap" "false")" = "true" ]; then
    fail "the plan says bootstrap=true: before its first apply there is no database to store a record in. Put it after the deploy."
  fi

  # The operations definition as ECS holds it now, which must be this environment's
  # worker image by digest; the task is held to exactly that image.
  local definition
  definition="$(release_task_definition "$environment" "$operations")"
  if [ -n "$definition" ]; then
    digest="$(FSS_JSON="$definition" FSS_REPOSITORY="${account}.dkr.ecr.${region}.amazonaws.com/${prefix}-worker" python3 -c '
import json, os, re, sys
definition = json.loads(os.environ["FSS_JSON"]) or {}
image = next((str(entry.get("image", "")) for entry in definition.get("containerDefinitions") or [] if entry.get("name") == "operations"), "")
match = re.fullmatch(re.escape(os.environ["FSS_REPOSITORY"]) + r"@(sha256:[0-9a-f]{64})", image)
if not match:
    sys.exit("the operations task definition runs {!r}, which is not {} by digest".format(image, os.environ["FSS_REPOSITORY"]))
print(match.group(1))
')" || fail "$stage: the operations task definition is not the worker image by digest (above); nothing was put."
  else
    digest='<read-from-the-operations-definition>'
  fi
  if [ "$digest" = "$worker" ]; then
    rehearsal_log "$stage: the operations task definition runs this release's worker image ($worker): the apply has run"
  else
    rehearsal_log "$stage: the put runs the operations task definition as it is now ($digest); the record names api $api and worker $worker"
  fi

  local step=release-record-put-before-rollout
  [ "$stage" = read-back ] && step=release-record-read-back
  release_record_put "$step" "$file" "$environment" "$prefix" "$account" "$region" "$cluster" "$operations" \
    "$digest" "$network_plan" "$host" "$secret" "$log_group" || exit 1
  if [ "$stage" = read-back ] && [ "$RELEASE_RECORD_OUTCOME" = created ] && [ "$allow_created" != 1 ]; then
    fail "the read-back had to create the release record: it was not stored before the rollout, which record.sh put should have done. It is stored now."
  fi
  rehearsal_write_report "release-record.txt" \
    "prefix=$prefix environment=$environment stage=$stage api_digest=$api worker_digest=$worker operations_digest=$digest release_record=$RELEASE_RECORD_OUTCOME"
  if [ "$stage" = put ]; then
    rehearsal_log "record: release record $RELEASE_RECORD_OUTCOME before the rollout; nothing was deployed. Next: the plan, the apply, the deploy, then record.sh read-back."
  else
    rehearsal_log "record: release record $RELEASE_RECORD_OUTCOME after the rollout"
  fi
}

SUBCOMMAND=${1:-}
shift || true
case "$SUBCOMMAND" in
  from-ci) record_from_ci "$@" ;;
  put | read-back) record_store "$SUBCOMMAND" "$@" ;;
  *) record_usage ;;
esac
