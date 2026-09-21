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
    "ThisNamespacesStateList": "fss-rh",
    "ThisNamespacesStateDynamoLock": "fss-rh",
    "UseTerraformStateKmsKey": "fss-rh",
    "NoDeploymentDataAccess": "fss-prod",
}

# The state key space each namespace owns. `fss/greenfield/rehearsal*` covers both the
# per-run space `fss/greenfield/rehearsal/<run>/terraform.tfstate` and the durable
# `fss/greenfield/rehearsal-registry/terraform.tfstate`, and cannot reach production's.
STATE_KEY_GLOB = {
    "fss-rh": "fss/greenfield/rehearsal*",
    "fss-prod": "fss/greenfield/production*",
}

substitutions = {
    "name_prefix": prefix,
    "aws_account_id": account,
    "aws_region": region,
    "state_bucket": state_bucket,
    "lock_table": env["FSS_POLICY_LOCK_TABLE"],
    "state_key_glob": STATE_KEY_GLOB[prefix],
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
]

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
