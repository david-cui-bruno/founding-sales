#!/usr/bin/env bash
# Print the inline policy document for one FSS deployment role. No cloud call.
#
#   infra/scripts/render-deployment-role-policy.sh fss-rh     > /tmp/fss-rh-deploy-scope.json
#   infra/scripts/render-deployment-role-policy.sh fss-prod   > /tmp/fss-prod-deploy-scope.json
#   infra/scripts/render-deployment-role-policy.sh fss-rh --sids     # the Sids, one per line
#   infra/scripts/render-deployment-role-policy.sh fss-rh --compact  # no indentation
#
# `docs/greenfield/infra-apply-runbook.md` 1.1 has the two `aws iam put-role-policy`
# commands this output is for. The document replaces the whole inline policy named
# `<prefix>-deploy-scope`; it is not a delta.
#
# The prefix is the only argument. Everything else is derived from it or overridable by
# an environment variable, and every value is a public identifier — an account number,
# a region, a bucket name, a table name, a KMS key id, an ARN. Nothing here is a
# credential and nothing here is read from one.
#
#   FSS_POLICY_ACCOUNT_ID        default 326255650484
#   FSS_POLICY_REGION            default us-east-1
#   FSS_POLICY_STATE_BUCKET      default callie-sourcing-tfstate-326255650484
#   FSS_POLICY_LOCK_TABLE        default callie-sourcing-tflock
#   FSS_POLICY_STATE_KMS_KEY_ARN default the state bucket's key
#   FSS_POLICY_CERTIFICATE_ARN   default every certificate in the account and region
#   FSS_POLICY_CARRY_SOURCE_TABLE  unset by default, and then nothing is rendered
#
# `FSS_POLICY_CARRY_SOURCE_TABLE` is the old stack's DynamoDB table — a public
# identifier, a table name and nothing else. Given it, the rehearsal role gets one
# read-only statement over that table and its indexes, which is what
# `infra/scripts/rehearsal-carry-watermark.sh` needs to run `fss carry export` under
# `fss-rh-deploy` (Appendix G 20). Unset, no such statement exists in either document,
# because the table does not exist until a cutover is scheduled and a policy naming a
# table nobody has is a grant nobody can review. Production never gets it at all.
#
#   FSS_POLICY_CARRY_SOURCE_TABLE=<the old table> \
#     infra/scripts/render-deployment-role-policy.sh fss-rh > /tmp/fss-rh-deploy-scope.json
#
# The certificate default is a wildcard on purpose. The exact ARNs are the `rehearsal`
# environment secret `FSS_REHEARSAL_CERTIFICATE_ARN` and its production counterpart, and
# a repository that shipped them would be a repository holding a value the workflow
# deliberately keeps out of it. `acm:DescribeCertificate` is read-only. To keep the
# narrower scoping David's hand-written policy had, pass the ARN:
#
#   FSS_POLICY_CERTIFICATE_ARN=arn:aws:acm:us-east-1:326255650484:certificate/<id> \
#     infra/scripts/render-deployment-role-policy.sh fss-rh
#
# Two statement sets are per-role rather than shared, and the script refuses to emit
# either for the wrong prefix:
#
#   * the rehearsal keeps the Terraform state statements, because the release
#     workflow's *ambient* credential is `fss-rh-deploy` and the S3 backend uses the
#     ambient credential rather than the provider's assumed role. It also keeps
#     `BypassGovernanceOnRehearsalBucketsOnly` (release.md 1.2) and the two statements
#     that let an unattended run fill and read its own database entries;
#   * production keeps `NoDeploymentDataAccess`, the blanket deny that includes
#     `secretsmanager:PutSecretValue` and `s3:BypassGovernanceRetention`. A production
#     apply is local and its state is read by David's own admin principal, so
#     `fss-prod-deploy` needs no state access at all.
#
# Dry run: there is nothing to dry-run. This script makes no call of any kind.

set -euo pipefail

PREFIX=${1:-}
MODE=${2:---pretty}

case "$PREFIX" in
  fss-rh | fss-prod) ;;
  *)
    echo "usage: $(basename "$0") <fss-rh|fss-prod> [--pretty|--compact|--sids]" >&2
    echo "FAIL: '$PREFIX' is not a deployment namespace. The two roles are fss-rh-deploy and fss-prod-deploy." >&2
    exit 2
    ;;
esac

case "$MODE" in
  --pretty | --compact | --sids) ;;
  *)
    echo "FAIL: '$MODE' is not a mode; use --pretty, --compact or --sids" >&2
    exit 2
    ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEMPLATE="$ROOT/infra/policies/deployment-role-policy.json.tftpl"

FSS_POLICY_PREFIX="$PREFIX" \
FSS_POLICY_MODE="$MODE" \
FSS_POLICY_TEMPLATE="$TEMPLATE" \
FSS_POLICY_ACCOUNT_ID="${FSS_POLICY_ACCOUNT_ID:-326255650484}" \
FSS_POLICY_REGION="${FSS_POLICY_REGION:-us-east-1}" \
FSS_POLICY_STATE_BUCKET="${FSS_POLICY_STATE_BUCKET:-callie-sourcing-tfstate-326255650484}" \
FSS_POLICY_LOCK_TABLE="${FSS_POLICY_LOCK_TABLE:-callie-sourcing-tflock}" \
FSS_POLICY_STATE_KMS_KEY_ARN="${FSS_POLICY_STATE_KMS_KEY_ARN:-}" \
FSS_POLICY_CERTIFICATE_ARN="${FSS_POLICY_CERTIFICATE_ARN:-}" \
FSS_POLICY_CARRY_SOURCE_TABLE="${FSS_POLICY_CARRY_SOURCE_TABLE:-}" \
python3 - <<'PY'
# render-deployment-role-policy: one template, one prefix, one document.
import json
import os
import re
import string
import sys

env = os.environ
prefix = env["FSS_POLICY_PREFIX"]
mode = env["FSS_POLICY_MODE"]
account = env["FSS_POLICY_ACCOUNT_ID"]
region = env["FSS_POLICY_REGION"]
state_bucket = env["FSS_POLICY_STATE_BUCKET"]

# Which statements belong to which role. A Sid named here and absent from the template
# is a failure: the alternative is a renderer that silently drops a deny.
RENDER_ONLY_FOR = {
    "BypassGovernanceOnRehearsalBucketsOnly": "fss-rh",
    "FillThisNamespacesDatabaseEntries": "fss-rh",
    "ReadTheRdsManagedMasterSecretOfThisNamespacesInstance": "fss-rh",
    "NoDeploymentSecretValueAccessButTheRdsManagedMasterSecret": "fss-rh",
    "NoDeploymentS3DataAccessOutsideTerraformState": "fss-rh",
    "ThisNamespacesStateObjects": "fss-rh",
    "ThisNamespacesStateLockFileCleanup": "fss-rh",
    "ThisRunsStateObjectCleanup": "fss-rh",
    "ThisNamespacesStateList": "fss-rh",
    "ThisNamespacesStateDynamoLock": "fss-rh",
    "UseTerraformStateKmsKey": "fss-rh",
    "ReadTheOldStackTableForTheCarryDrill": "fss-rh",
    "NoDeploymentDataAccess": "fss-prod",
}

# The state key space each namespace owns. `fss/greenfield/rehearsal*` covers both the
# per-run space `fss/greenfield/rehearsal/<run>/terraform.tfstate` and the durable
# `fss/greenfield/rehearsal-registry/terraform.tfstate`, and cannot reach production's.
STATE_KEY_GLOB = {
    "fss-rh": "fss/greenfield/rehearsal*",
    "fss-prod": "fss/greenfield/production*",
}

# The narrower space a *run's own* state object lives in, which is what the teardown
# deletes. `fss/greenfield/rehearsal/*/terraform.tfstate` cannot reach
# `fss/greenfield/rehearsal-registry/terraform.tfstate` — the registry key has no `/`
# after `rehearsal` — and cannot reach production's at all. The production entry is
# here because `string.Template` needs every name the template mentions; the statement
# that uses it is rehearsal-only and is never emitted for production.
RUN_STATE_KEY_GLOB = {
    "fss-rh": "fss/greenfield/rehearsal/*/terraform.tfstate",
    "fss-prod": "fss/greenfield/production/terraform.tfstate",
}

# The old stack's DynamoDB table, when David gives it, and the value that stands in its
# place when he does not. The statement has to render before it can be filtered out, so
# the sentinel is what renders; a sentinel that survived into the document would be a
# grant on a table called `CARRY_SOURCE_TABLE_UNSET`, which is why it is checked for
# below rather than trusted to be gone.
CARRY_SOURCE_TABLE_UNSET = "CARRY_SOURCE_TABLE_UNSET"
CARRY_SOURCE_TABLE_SID = "ReadTheOldStackTableForTheCarryDrill"

carry_source_table = env["FSS_POLICY_CARRY_SOURCE_TABLE"].strip()
if carry_source_table:
    # A DynamoDB table name, and nothing that could be an ARN, a path or a production
    # resource. The value becomes part of a Resource ARN, so a value with a `/` or a
    # `:` in it would silently widen or misdirect the grant.
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,255}", carry_source_table):
        sys.exit(
            "FAIL: FSS_POLICY_CARRY_SOURCE_TABLE must be a DynamoDB table name "
            "(3 to 255 of A-Z a-z 0-9 _ . -) and nothing else; it is substituted into a Resource ARN"
        )
    if carry_source_table.startswith("fss-prod"):
        sys.exit(
            "FAIL: FSS_POLICY_CARRY_SOURCE_TABLE names a production resource; "
            "the carry reads the old stack's table, never anything in the fss-prod namespace"
        )

substitutions = {
    "name_prefix": prefix,
    "aws_account_id": account,
    "aws_region": region,
    "state_bucket": state_bucket,
    "lock_table": env["FSS_POLICY_LOCK_TABLE"],
    "state_key_glob": STATE_KEY_GLOB[prefix],
    "run_state_key_glob": RUN_STATE_KEY_GLOB[prefix],
    "carry_source_table": carry_source_table or CARRY_SOURCE_TABLE_UNSET,
    "deployment_role_arn": f"arn:aws:iam::{account}:role/{prefix}-deploy",
    "state_kms_key_arn": env["FSS_POLICY_STATE_KMS_KEY_ARN"]
    or f"arn:aws:kms:{region}:{account}:key/a321a083-4058-4130-b060-b950e4aa1404",
    "certificate_arn": env["FSS_POLICY_CERTIFICATE_ARN"]
    or f"arn:aws:acm:{region}:{account}:certificate/*",
}

template = open(env["FSS_POLICY_TEMPLATE"], encoding="utf-8").read()
try:
    rendered = string.Template(template).substitute(substitutions)
except KeyError as missing:
    sys.exit(f"FAIL: the template names {missing}, which this script does not supply")

document = json.loads(rendered)
document.pop("Comment", None)

present = {statement["Sid"] for statement in document["Statement"]}
for sid, owner in sorted(RENDER_ONLY_FOR.items()):
    if sid not in present:
        sys.exit(
            f"FAIL: {sid} is named as {owner}-only and is not in the template; "
            "a per-role statement that has been renamed must be renamed here too"
        )

document["Statement"] = [
    statement
    for statement in document["Statement"]
    if RENDER_ONLY_FOR.get(statement["Sid"], prefix) == prefix
    and (statement["Sid"] != CARRY_SOURCE_TABLE_SID or bool(carry_source_table))
]

# Fail closed on the sentinel rather than trust the filter above: a renamed Sid would
# otherwise ship a grant on a table nobody named.
if CARRY_SOURCE_TABLE_UNSET in json.dumps(document):
    sys.exit(
        f"FAIL: {CARRY_SOURCE_TABLE_SID} rendered with no table name. It is emitted only when "
        "FSS_POLICY_CARRY_SOURCE_TABLE is set, and the filter that drops it names the Sid."
    )

if mode == "--sids":
    for statement in document["Statement"]:
        print(f'{statement["Effect"]:6} {statement["Sid"]}')
    raise SystemExit(0)

# IAM ignores white space when it measures an inline policy against the 10,240-character
# limit, and this is the measurement it makes. A policy that has grown past it is not a
# policy `put-role-policy` will take, and finding that out from the CLI in the middle of
# a release is the failure this check exists to move to a pull request.
measured = len(re.sub(r"\s", "", json.dumps(document, separators=(",", ":"))))
if measured >= 10_240:
    sys.exit(
        f"FAIL: the rendered {prefix}-deploy-scope measures {measured} characters of "
        "non-white-space and IAM's limit for one inline role policy is 10240. Split it "
        "into two policies, or scope something more tightly."
    )

if mode == "--compact":
    print(json.dumps(document, separators=(",", ":")))
else:
    print(json.dumps(document, indent=2))
PY
