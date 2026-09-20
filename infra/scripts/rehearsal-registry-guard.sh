#!/usr/bin/env bash
# The plan guard for `infra/roots/rehearsal-registry`, and the printed plan of the
# commands its apply workflow runs.
#
#   infra/scripts/rehearsal-registry-guard.sh commands
#   infra/scripts/rehearsal-registry-guard.sh plan <terraform show -json output>
#
# ## Why a guard at all
#
# `.github/workflows/greenfield-rehearsal-registry.yml` is the only place
# `fss-rh-deploy` is ever assumed for this root, because that role trusts the GitHub
# OIDC provider and the subject `…:environment:rehearsal` and nothing else
# (Appendix G 39, `docs/greenfield/release.md` 1.3). An operator therefore cannot read
# the plan in a terminal and decide: the plan exists only inside a run. So the first
# reading is done by this script, and the second by the operator, who reads the run's
# summary and then dispatches the same workflow again with `apply=true`.
#
# This is what stands where a person's eyes used to. It refuses to let an apply
# proceed unless the plan is *only* the two durable rehearsal repositories and their
# lifecycle policies:
#
#   1. every planned resource type is one this root creates;
#   2. every planned resource name is in the `fss-rh-` namespace;
#   3. every address is inside `module.registry`;
#   4. nothing is destroyed or replaced.
#
# (4) is the one that matters most. `force_delete = false` means a *destroy* of a
# repository holding images fails, which is the correct answer; it does not stop a
# **replacement** — a change to an attribute that forces new — which Terraform
# proposes as delete-then-create and which would take every image past releases were
# rehearsed on with it.
#
# ## The expected types are the types this root creates, not every type it might
#
# `infra/modules/registry` declares `aws_ecr_repository` and
# `aws_ecr_lifecycle_policy` and nothing else. In particular it declares no
# `aws_ecr_repository_policy`: there is no cross-account pull here, and the rehearsal
# tasks pull with an execution role in the same account. A plan containing one is a
# root somebody changed, and that is exactly the plan a guard should stop rather than
# wave through on a list of types that might one day be wanted.
# `docs/decisions/g12d-the-once-only-registry-apply-is-a-workflow.md`.
#
# Dry run: `commands` needs no credential. It is what the release workflow's
# pull-request job prints, so the plan of this apply is read on every change, and the
# release suite requires every line it prints to appear in the workflow that runs it.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rehearsal-common.sh"

# The two resource types `infra/roots/rehearsal-registry` creates, and nothing else.
REGISTRY_EXPECTED_TYPES='aws_ecr_repository aws_ecr_lifecycle_policy'
# The namespace every name it creates is in. `fss-rh` is a literal in that root rather
# than a variable, so this is a fact about the root, not about a caller's argument.
REGISTRY_NAME_PREFIX='fss-rh-'
# The one module the root instantiates.
REGISTRY_MODULE_ADDRESS='module.registry'
# The two names the release workflow's repository secrets point at.
REGISTRY_REPOSITORIES='fss-rh-api fss-rh-worker'

# The commands the apply workflow runs, in order. Account-specific values are shown as
# the name of the thing that supplies them, never as the value.
#
# The plan carries `-var=assume_deployment_role=false` because the run's session is
# already `fss-rh-deploy` and the provider must not ask STS to assume the role it
# already holds — the refusal G12d could only predict. The line before it is what makes
# that flag safe: the session is named and judged before Terraform is given it
# (`docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`).
registry_command_plan() {
  rehearsal_plan "infra/scripts/rehearsal-caller-identity.sh fss-rh-deploy"
  rehearsal_plan "terraform -chdir=infra/roots/rehearsal-registry init -input=false -backend-config=backend.hcl <plus -backend-config=kms_key_id=… when the FSS_REHEARSAL_STATE_KMS_KEY_ARN environment secret is set>"
  rehearsal_plan "terraform -chdir=infra/roots/rehearsal-registry plan -input=false -lock-timeout=5m -var=assume_deployment_role=false -out=rehearsal-registry.tfplan"
  rehearsal_plan "terraform -chdir=infra/roots/rehearsal-registry show -json rehearsal-registry.tfplan > rehearsal-registry.plan.json"
  rehearsal_plan "infra/scripts/rehearsal-registry-guard.sh plan rehearsal-registry.plan.json"
  rehearsal_plan "terraform -chdir=infra/roots/rehearsal-registry apply -input=false -lock-timeout=5m rehearsal-registry.tfplan # only when apply=true"
  rehearsal_plan "aws ecr describe-repositories --repository-names fss-rh-api fss-rh-worker # only when apply=true"
}

# Read the plan and say yes or no. Prints one line per resource — address, action and
# the name it claims in the account — and a counted verdict. No attribute value other
# than that name is ever printed: the name is the thing being judged and it is public
# (`fss-rh-api`, `fss-rh-worker`), while everything else in a plan is not this
# script's business.
registry_guard_plan() {
  local plan_json=$1
  REGISTRY_EXPECTED_TYPES="$REGISTRY_EXPECTED_TYPES" \
  REGISTRY_NAME_PREFIX="$REGISTRY_NAME_PREFIX" \
  REGISTRY_MODULE_ADDRESS="$REGISTRY_MODULE_ADDRESS" \
  REGISTRY_REPOSITORIES="$REGISTRY_REPOSITORIES" \
  PRODUCTION_PREFIX="$PRODUCTION_PREFIX" \
  python3 - "$plan_json" <<'PY'
import json, os, sys

path = sys.argv[1]
expected_types = set(os.environ["REGISTRY_EXPECTED_TYPES"].split())
name_prefix = os.environ["REGISTRY_NAME_PREFIX"]
module_address = os.environ["REGISTRY_MODULE_ADDRESS"]
repositories = set(os.environ["REGISTRY_REPOSITORIES"].split())
production_prefix = os.environ["PRODUCTION_PREFIX"]

try:
    with open(path, encoding="utf-8") as handle:
        plan = json.load(handle)
except (OSError, ValueError) as error:
    print("FAIL: the plan JSON could not be read: %s" % error)
    raise SystemExit(1)

changes = plan.get("resource_changes")
if not isinstance(changes, list):
    print("FAIL: the plan has no resource_changes array, so it is not a terraform show -json plan")
    raise SystemExit(1)

problems = []
counts = {"create": 0, "update": 0, "no-op": 0, "read": 0, "destroy": 0}
names = set()
lines = []

for change in changes:
    address = str(change.get("address", "<no address>"))
    kind = str(change.get("type", "<no type>"))
    actions = [str(action) for action in change.get("change", {}).get("actions", [])]

    if "delete" in actions:
        counts["destroy"] += 1
        problems.append("%s (%s) would be destroyed or replaced: %s" % (address, kind, "+".join(actions)))
    elif "create" in actions:
        counts["create"] += 1
    elif "update" in actions:
        counts["update"] += 1
    elif "read" in actions:
        counts["read"] += 1
    else:
        counts["no-op"] += 1

    if kind not in expected_types:
        problems.append(
            "%s is a %s, which this root does not create; the expected types are %s"
            % (address, kind, ", ".join(sorted(expected_types)))
        )

    if str(change.get("module_address", "")) != module_address:
        problems.append("%s is outside %s, which is the only module this root instantiates" % (address, module_address))

    after = change.get("change", {}).get("after") or {}
    name = after.get("name") or after.get("repository") or after.get("repository_name")
    if not isinstance(name, str) or name == "":
        problems.append("%s has no readable name in the plan, so the namespace cannot be checked" % address)
        name = "<unnamed>"
    else:
        names.add(name)
        if name.startswith(production_prefix):
            problems.append("%s names a production resource: %s" % (address, name))
        elif not name.startswith(name_prefix):
            problems.append("%s names %s, which is outside the %s namespace" % (address, name, name_prefix))

    lines.append("  %s  %s  %s" % (address, "+".join(actions) or "none", name))

unexpected = names - repositories - {"<unnamed>"}
if unexpected:
    problems.append(
        "the plan claims names this root does not own: %s" % ", ".join(sorted(unexpected))
    )

print("rehearsal-registry plan:")
for line in lines:
    print(line)
print(
    "verdict: create=%d update=%d no-op=%d read=%d destroy=%d repositories=%s"
    % (
        counts["create"],
        counts["update"],
        counts["no-op"],
        counts["read"],
        counts["destroy"],
        ",".join(sorted(names)) or "none",
    )
)

if problems:
    for problem in problems:
        print("FAIL: %s" % problem)
    raise SystemExit(1)
PY
}

MODE=${1:-}
case "$MODE" in
  commands)
    rehearsal_log "the rehearsal registry apply, as the commands the workflow runs"
    registry_command_plan
    ;;
  plan)
    PLAN_JSON=${2:-}
    if [ -z "$PLAN_JSON" ]; then
      echo "FAIL: usage: rehearsal-registry-guard.sh plan <terraform show -json output>" >&2
      exit 1
    fi
    if [ ! -f "$PLAN_JSON" ]; then
      # A step that did not run leaves no file, and a guard that treated that as
      # "nothing to object to" would approve every plan it never saw.
      echo "FAIL: there is no plan at $PLAN_JSON; the guard cannot approve a plan it never saw" >&2
      exit 1
    fi
    if summary="$(registry_guard_plan "$PLAN_JSON")"; then
      printf '%s\n' "$summary"
      rehearsal_write_report "rehearsal-registry-plan.txt" "$summary"
      rehearsal_log "pass: the plan creates only the durable rehearsal repositories"
    else
      printf '%s\n' "$summary" >&2
      echo "FAIL: the rehearsal registry plan was refused; do not apply it" >&2
      exit 1
    fi
    ;;
  *)
    echo "FAIL: usage: rehearsal-registry-guard.sh commands | rehearsal-registry-guard.sh plan <plan.json>" >&2
    exit 1
    ;;
esac
