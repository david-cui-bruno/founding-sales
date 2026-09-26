#!/usr/bin/env bash
# The release record, from the CI gate (lane g96; the owner's axiom 10B, 25 September 2026).
#
#   infra/scripts/release-record-from-ci.sh <gate run id> <commit> <api digest> <worker digest> \
#       [--enables-sending] [--out <file>]
#
# The worker sends only under a stored release record that names its image digest
# (lane g71, schema 17). Until g96 that record came from a green `full` rehearsal
# (`rehearsal-release-record.sh`). It now comes from the CI gate that was green on the
# deployed commit, and this script is what writes it. Sending itself is unchanged: the
# deployment flag plus the owner's attestation (`docs/greenfield/release.md` section 6).
#
# It reads GitHub, and nothing else. No AWS call, no credential beyond `gh`'s own login:
#
#   1. the gate run (`gh api repos/<repo>/actions/runs/<id>`) must be a run of the
#      workflow file `.github/workflows/greenfield.yml` — its `path`, never its display
#      name, which any other workflow can also carry (lane A1) — `completed` with
#      conclusion `success` on its latest attempt, a `push` to `main` of this
#      repository, at exactly <commit>;
#   2. the images run for the same commit (`gh api repos/<repo>/actions/workflows/
#      greenfield-images.yml/runs`), a run of `.github/workflows/greenfield-images.yml`
#      by its path and the newest push to main, must be `completed`/`success`;
#   3. that run's `fss-image-digests` artifact (`gh run download`) must be
#      `fss.image-digests.v1` for <commit> and that run, and name exactly <api digest>
#      and <worker digest>.
#
# Then it writes `fss.release-record.v1` with `source: "ci-gate"`, in the shape
# `ciGateReleaseRecordSchema` (`packages/contracts/src/release.ts`) accepts and
# `fss admin release-record put` stores:
#
#   * `releaseGateReference` — `ci-gate-<gate run id>-<first 12 of the commit>`, the
#     string the owner's attestation names;
#   * `recordedAt` — when the gate run concluded (its `updatedAt`), so building the
#     record twice for one run writes the same bytes and a second put says `existing`;
#   * `suite: "pass"`, `commit`, `gateRunId`, `gateRunUrl`, `imagesRunId`;
#   * `artifacts` — the two digests, and the commit as the desktop commit stamp;
#   * `enablesSending` — true only with `--enables-sending`. Nothing binds on it.
#
# Any mismatch is a refusal: one line on stderr beginning `FAIL:`, exit 1, and no file
# (`--out` is written through a temporary file and moved into place last). Without
# `--out` the record goes to stdout.
#
# A commit that changed no image input has no images run of its own; its images are
# the last image commit's, and that commit (which the gate also ran on) is the one to
# record and deploy.
#
# Repository: `GITHUB_REPOSITORY` (owner/name) when set, as in Actions; otherwise `gh`
# uses the checkout's remote (`{owner}/{repo}` in `gh api`). Seam for the offline check
# (`test/release/releaseRecordFromCi.check.ts`): `gh` is whatever is first on PATH, or
# `FSS_GH_COMMAND`.
#
# It sources the shared rules like every release script (`set -euo pipefail` and the
# log line), and addresses no resource, so the prefix guard has nothing to judge.

# shellcheck source=infra/scripts/rehearsal-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

# Each workflow by its file (lane A1). The names are for messages only.
GATE_WORKFLOW_PATH='.github/workflows/greenfield.yml'
GATE_WORKFLOW_NAME='Greenfield gate'
IMAGES_WORKFLOW_PATH='.github/workflows/greenfield-images.yml'
IMAGES_WORKFLOW_NAME='Greenfield images'
IMAGE_DIGESTS_ARTIFACT='fss-image-digests'
IMAGE_DIGESTS_FILE='image-digests.json'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

usage() {
  echo "usage: release-record-from-ci.sh <gate run id> <commit> <api digest> <worker digest> [--enables-sending] [--out <file>]" >&2
  exit 2
}

GATE_RUN_ID=''
COMMIT=''
API_DIGEST=''
WORKER_DIGEST=''
ENABLES_SENDING=false
OUT=''
POSITIONAL=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --enables-sending) ENABLES_SENDING=true; shift ;;
    --out)
      [ "$#" -ge 2 ] || usage
      OUT=$2
      shift 2
      ;;
    --*) fail "release-record-from-ci.sh does not take '$1'" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
[ "${#POSITIONAL[@]}" -eq 4 ] || usage
GATE_RUN_ID=${POSITIONAL[0]}
COMMIT=${POSITIONAL[1]}
API_DIGEST=${POSITIONAL[2]}
WORKER_DIGEST=${POSITIONAL[3]}

# Every argument is judged before GitHub is asked anything.
[[ "$GATE_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]] || fail "the gate run id '$GATE_RUN_ID' is not a GitHub Actions run id"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "the commit '$COMMIT' is not a full forty-character commit"
for digest in "$API_DIGEST" "$WORKER_DIGEST"; do
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "'$digest' is not an image digest (sha256:<64 hex>). The record names images, and a tag is mutable."
done
[ "$API_DIGEST" != "$WORKER_DIGEST" ] || fail "the API and worker digests are identical; one image was pushed under both names"

REPO_ARGS=()
# `gh api` fills {owner}/{repo} from the checkout's remote, as `gh run` does without --repo.
REPO_PATH='{owner}/{repo}'
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  [[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GITHUB_REPOSITORY '$GITHUB_REPOSITORY' is not owner/name"
  REPO_ARGS=(--repo "$GITHUB_REPOSITORY")
  REPO_PATH=$GITHUB_REPOSITORY
fi

gh_cli() {
  command "${FSS_GH_COMMAND:-gh}" "$@"
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fss-ci-record.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. The gate run, as the REST API describes it: `path` is the workflow file.
gh_cli api "repos/$REPO_PATH/actions/runs/$GATE_RUN_ID" \
  > "$WORK/gate.json" 2> "$WORK/gate.err" \
  || fail "gh could not read run $GATE_RUN_ID: $(head -n 1 "$WORK/gate.err")"

# 2. The images runs of the same commit, of the images workflow file.
gh_cli api "repos/$REPO_PATH/actions/workflows/${IMAGES_WORKFLOW_PATH##*/}/runs?head_sha=$COMMIT&event=push&branch=main&per_page=20" \
  > "$WORK/images-runs.json" 2> "$WORK/images.err" \
  || fail "gh could not list the $IMAGES_WORKFLOW_NAME runs of $COMMIT: $(head -n 1 "$WORK/images.err")"

# Judge both; print the images run id, or refuse naming the first thing wrong.
IMAGES_RUN_ID="$(FSS_WORK="$WORK" FSS_GATE_RUN_ID="$GATE_RUN_ID" FSS_COMMIT="$COMMIT" \
  FSS_REPOSITORY="${GITHUB_REPOSITORY:-}" \
  FSS_GATE_PATH="$GATE_WORKFLOW_PATH" FSS_GATE_WORKFLOW="$GATE_WORKFLOW_NAME" \
  FSS_IMAGES_PATH="$IMAGES_WORKFLOW_PATH" FSS_IMAGES_WORKFLOW="$IMAGES_WORKFLOW_NAME" python3 - <<'PY'
import json, os, re, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

env = os.environ
work, run_id, commit = env["FSS_WORK"], env["FSS_GATE_RUN_ID"], env["FSS_COMMIT"]

def workflow_path(run):
    return str(run.get("path", "")).split("@")[0]

try:
    gate = json.load(open(os.path.join(work, "gate.json"), encoding="utf-8"))
except ValueError:
    fail("gh's answer for run {} is not JSON".format(run_id))
if not isinstance(gate, dict):
    fail("gh's answer for run {} is not a run".format(run_id))
if str(gate.get("id")) != run_id:
    fail("gh answered for run {}, not {}".format(gate.get("id"), run_id))
if workflow_path(gate) != env["FSS_GATE_PATH"]:
    fail("run {} is a run of '{}' (named '{}'), not of {}, the {} workflow".format(
        run_id, gate.get("path"), gate.get("name"), env["FSS_GATE_PATH"], env["FSS_GATE_WORKFLOW"]))
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
    fail("gh's list of {} runs is not JSON".format(env["FSS_IMAGES_WORKFLOW"]))
if not isinstance(listed, dict) or not isinstance(listed.get("workflow_runs"), list):
    fail("gh's list of {} runs is not a list of runs".format(env["FSS_IMAGES_WORKFLOW"]))
runs = [run for run in listed["workflow_runs"] if isinstance(run, dict)
        and workflow_path(run) == env["FSS_IMAGES_PATH"]
        and run.get("head_sha") == commit and run.get("event") == "push" and run.get("head_branch") == "main"
        and (run.get("head_repository") or {}).get("full_name") == repository
        and re.match(r"^[1-9][0-9]{0,19}$", str(run.get("id", "")))]
if not runs:
    fail("no {} run pushed to main at {}; a commit that changed no image input has the images of the last one that did, so record and deploy that commit".format(env["FSS_IMAGES_WORKFLOW"], commit))
runs.sort(key=lambda run: (str(run.get("created_at", "")), int(run["id"])), reverse=True)
images = runs[0]
images_id = str(images["id"])
if images.get("status") != "completed" or images.get("conclusion") != "success":
    fail("the {} run {} for {} is {}/{}, not completed/success".format(
        env["FSS_IMAGES_WORKFLOW"], images_id, commit, images.get("status"), images.get("conclusion")))
images_url = str(images.get("html_url", ""))
if not images_url.startswith("https://github.com/{}/actions/runs/".format(repository)):
    fail("the {} run {} is in another repository than gate run {}".format(env["FSS_IMAGES_WORKFLOW"], images_id, run_id))
if images_id == run_id:
    fail("the images run and the gate run are the same run, {}".format(run_id))
with open(os.path.join(work, "gate-facts.json"), "w", encoding="utf-8") as handle:
    json.dump({"url": url, "updatedAt": updated}, handle)
print(images_id)
PY
)" || exit 1

# 3. The digests that images run published.
mkdir -p "$WORK/artifact"
gh_cli run download "$IMAGES_RUN_ID" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} --name "$IMAGE_DIGESTS_ARTIFACT" --dir "$WORK/artifact" \
  > /dev/null 2> "$WORK/download.err" \
  || fail "images run $IMAGES_RUN_ID has no $IMAGE_DIGESTS_ARTIFACT artifact gh could download: $(head -n 1 "$WORK/download.err")"

FSS_WORK="$WORK" FSS_FILE="$WORK/artifact/$IMAGE_DIGESTS_FILE" FSS_COMMIT="$COMMIT" FSS_GATE_RUN_ID="$GATE_RUN_ID" \
FSS_IMAGES_RUN_ID="$IMAGES_RUN_ID" FSS_API="$API_DIGEST" FSS_WORKER="$WORKER_DIGEST" \
FSS_ENABLES_SENDING="$ENABLES_SENDING" python3 - > "$WORK/release-record.json" <<'PY'
import json, os, sys

def fail(message):
    print("FAIL: " + message, file=sys.stderr)
    sys.exit(1)

env = os.environ
commit, images_id = env["FSS_COMMIT"], env["FSS_IMAGES_RUN_ID"]
try:
    document = json.load(open(env["FSS_FILE"], encoding="utf-8"))
except (OSError, ValueError):
    fail("the {} artifact of images run {} holds no readable image-digests.json".format("fss-image-digests", images_id))
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
        fail("the {} image of images run {} is {}:{}, not fss-rh-{}:ci-{}".format(
            service, images_id, entry.get("repository"), entry.get("tag"), service, commit))
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

REFERENCE="ci-gate-${GATE_RUN_ID}-${COMMIT:0:12}"
if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  cp "$WORK/release-record.json" "$OUT.partial"
  mv "$OUT.partial" "$OUT"
  rehearsal_log "release record $REFERENCE (ci-gate, gate run $GATE_RUN_ID, images run $IMAGES_RUN_ID, enablesSending=$ENABLES_SENDING) written to $OUT" >&2
else
  cat "$WORK/release-record.json"
fi
