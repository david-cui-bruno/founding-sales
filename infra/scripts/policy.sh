#!/usr/bin/env bash
# The two deployment roles' inline policy: render it, check it, put it (P7, 27 September
# 2026; it replaces render-deployment-role-policy.sh and check-deployment-role.sh, which
# exec it with the same arguments).
#
#   policy.sh render <fss-rh|fss-prod> [--pretty|--compact|--sids]    no call of any kind
#   policy.sh check  <fss-rh-deploy|fss-prod-deploy> <fss-rh|fss-prod>  read-only simulation
#   policy.sh put    <fss-rh|fss-prod> [--environment production] [--allow-widening]
#
# docs/greenfield/infra-apply-runbook.md 1.1 is the operator's page. The document replaces
# the whole inline policy named `<prefix>-deploy-scope` on `<prefix>-deploy`; it is not a
# delta. Every value in it is a public identifier.
#
# ## render
#
# `infra/policies/deployment-role-policy.json.tftpl` for one prefix. Every default is the
# one account and region FSS runs in; the variables exist so the offline tests can render
# other values:
#
#   FSS_POLICY_ACCOUNT_ID        default 326255650484
#   FSS_POLICY_REGION            default us-east-1
#   FSS_POLICY_STATE_BUCKET      default callie-sourcing-tfstate-326255650484
#   FSS_POLICY_LOCK_TABLE        default callie-sourcing-tflock
#   FSS_POLICY_STATE_KMS_KEY_ID  default a321a083-4058-4130-b060-b950e4aa1404
#   FSS_POLICY_STATE_KMS_KEY_ARN default the key id above, in this account and region
#   FSS_POLICY_CERTIFICATE_ARN   default every certificate in the account and region
#
# The certificate default is a wildcard (acm:DescribeCertificate is read-only); pass the ARN
# to keep the narrower scoping. Two statement sets are per role, and the renderer refuses to
# emit either for the wrong prefix: the rehearsal keeps the Terraform state statements (the
# release workflow's ambient credential is fss-rh-deploy and the S3 backend uses it),
# BypassGovernanceOnRehearsalBucketsOnly (release.md 1.2) and the two statements that let an
# unattended run fill and read its own database entries; production keeps
# NoDeploymentDataAccess, the blanket deny that includes secretsmanager:PutSecretValue and
# s3:BypassGovernanceRetention. It checks IAM's ARN grammar and the 10,240-character limit
# before put-role-policy can refuse either in the middle of a release.
#
# ## check
#
# `aws iam simulate-principal-policy`, which evaluates a policy and performs nothing, for
# every action the next apply and the release scripts need, against sample ARNs of the
# namespace that need not exist. The table below is this script's own list: every action
# of that run, at least one per service the Terraform tree uses, and the actions the
# release scripts make outside Terraform. The table is 25 groups, 115 action entries over
# 108 distinct actions, for production; the rehearsal adds one group (116 entries, the same
# 108 actions) for the master secret under the service tag key. `test/ops/policy.check.ts`
# counts the plan, so a row added or lost without a word here fails the gate.
# What keeps the rendered policy in step with the
# Terraform tree is a different check, `test/ops/deploymentRolePolicy.check.ts` over
# `infra/policies/terraform-resource-actions.json` (W3-T owns both).
#
# Run it before any apply: the fourth credentialed rehearsal (Actions run 35628963637,
# 21 September 2026) spent an apply and a failed teardown discovering six classes of
# denial that this answers in seconds. Exit 0 when every action
# is allowed, 1 when any is not or when the simulation answered nothing ("no denials" and
# "no results" must not look the same), 2 for wrong arguments.
#
#   FSS_CHECK_ROLE_DRY_RUN=1   print the plan, make no call, exit 0
#   FSS_CHECK_ROLE_AWS=<path>  the CLI, for the offline test's stub
#   FSS_CHECK_ROLE_ACCOUNT_ID, FSS_CHECK_ROLE_REGION  the sample ARNs' account and region
#
# ## put (new in P7)
#
# The two commands the runbook had an operator type, in one: the document `render
# --compact` prints, put with `aws iam put-role-policy`, then read back with
# `get-role-policy` and compared as JSON. It prints which Sids the put adds, removes and
# changes against what the role held. It refuses a session in any account but the one the
# document was rendered for (a policy naming another account's resources is not this
# account's policy), and production unless it is named out loud (--environment production).
#
# **A put that widens the role stops** (review of PR 292). Printing the Sid diff and then
# writing it anyway makes the diff a courtesy; a rendered template that adds an Allow or
# drops a Deny would be put by a command run for an unrelated reason. So a statement added
# under Effect Allow, a Deny that is gone, and a change that adds an action or a resource
# to an Allow or takes one from a Deny are each a refusal that names the Sid. Narrowing —
# an Allow removed, a Deny added, an action dropped from an Allow — is put without
# ceremony, and so is the first put of all: a role that holds no `<prefix>-deploy-scope`
# yet has nothing to widen. `--allow-widening` is how a widening is put on purpose, and the
# line it prints says what was widened, so a release record can carry it.
#
#   FSS_POLICY_AWS=<path>      the CLI, for the offline test's stub
#
# `test/ops/deploymentRolePolicy.check.ts` renders and checks; `test/ops/policy.check.ts`
# puts, and holds the old names to the new.

set -euo pipefail

POLICY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.sh"

policy_usage() {
  cat >&2 <<'USAGE'
usage: policy.sh render <fss-rh|fss-prod> [--pretty|--compact|--sids]
       policy.sh check  <fss-rh-deploy|fss-prod-deploy> <fss-rh|fss-prod>
       policy.sh put    <fss-rh|fss-prod> [--environment production] [--allow-widening]
USAGE
  exit 2
}

# ===========================================================================
# render
# ===========================================================================
policy_render() {
PREFIX=${1:-}
MODE=${2:---pretty}

case "$PREFIX" in
  fss-rh | fss-prod) ;;
  *)
    echo "usage: policy.sh render <fss-rh|fss-prod> [--pretty|--compact|--sids]" >&2
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

if [ "$#" -gt 2 ]; then
  echo "FAIL: '$3' is not an option; the script takes a prefix and a mode and nothing else" >&2
  exit 2
fi

TEMPLATE="$POLICY_ROOT/infra/policies/deployment-role-policy.json.tftpl"

FSS_POLICY_PREFIX="$PREFIX" \
FSS_POLICY_MODE="$MODE" \
FSS_POLICY_TEMPLATE="$TEMPLATE" \
FSS_POLICY_ACCOUNT_ID="${FSS_POLICY_ACCOUNT_ID:-326255650484}" \
FSS_POLICY_REGION="${FSS_POLICY_REGION:-us-east-1}" \
FSS_POLICY_STATE_BUCKET="${FSS_POLICY_STATE_BUCKET:-callie-sourcing-tfstate-326255650484}" \
FSS_POLICY_LOCK_TABLE="${FSS_POLICY_LOCK_TABLE:-callie-sourcing-tflock}" \
FSS_POLICY_STATE_KMS_KEY_ID="${FSS_POLICY_STATE_KMS_KEY_ID:-a321a083-4058-4130-b060-b950e4aa1404}" \
FSS_POLICY_STATE_KMS_KEY_ARN="${FSS_POLICY_STATE_KMS_KEY_ARN:-}" \
FSS_POLICY_CERTIFICATE_ARN="${FSS_POLICY_CERTIFICATE_ARN:-}" \
python3 - <<'PY'
# policy-render: one template, one prefix, one document.
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
    # The Terraform state key. Its id is a per-account value with the shared
    # account's as its default assignment above, so the ARN is built in whatever
    # account and region this render is for and no account is written in here.
    "state_kms_key_arn": env["FSS_POLICY_STATE_KMS_KEY_ARN"]
    or f"arn:aws:kms:{region}:{account}:key/{env['FSS_POLICY_STATE_KMS_KEY_ID']}",
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

# IAM's ARN grammar, checked here rather than by put-role-policy in the middle of a release:
# the partition and the service segment are literal (`Resource vendor must be fully qualified
# and cannot contain regexes`, 22 September 2026, for arn:aws:*:*:*:*fss-prod*); region,
# account and the resource may carry wildcards; a bare `*` is the only non-ARN form.
ARN_PARTS = 6
for statement in document["Statement"]:
    for field in ("Resource", "NotResource"):
        value = statement.get(field)
        if value is None:
            continue
        for arn in value if isinstance(value, list) else [value]:
            if arn == "*":
                continue
            parts = arn.split(":", ARN_PARTS - 1)
            if len(parts) != ARN_PARTS or parts[0] != "arn" or parts[1] != "aws":
                sys.exit(f"FAIL: {statement['Sid']} names a resource that is not an ARN: {arn}")
            if not re.fullmatch(r"[a-z0-9-]+", parts[2]):
                sys.exit(
                    f"FAIL: {statement['Sid']} names a resource whose service segment is not literal: {arn}. "
                    "IAM requires the service to be fully qualified; write one resource per service."
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
}

# ===========================================================================
# check
# ===========================================================================
policy_check() {
ROLE=${1:-}
PREFIX=${2:-}
ACCOUNT=${FSS_CHECK_ROLE_ACCOUNT_ID:-326255650484}
REGION=${FSS_CHECK_ROLE_REGION:-us-east-1}

case "$ACCOUNT" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "FAIL: FSS_CHECK_ROLE_ACCOUNT_ID is '$ACCOUNT'; an AWS account id is twelve digits" >&2
    exit 2
    ;;
esac
AWS=${FSS_CHECK_ROLE_AWS:-aws}

usage() {
  echo "usage: policy.sh check <fss-rh-deploy|fss-prod-deploy> <fss-rh|fss-prod>" >&2
}

case "$ROLE" in
  fss-rh-deploy | fss-prod-deploy) ;;
  *)
    usage
    echo "FAIL: '$ROLE' is not a deployment role. The two are fss-rh-deploy and fss-prod-deploy." >&2
    exit 2
    ;;
esac

case "$PREFIX" in
  fss-rh | fss-prod) ;;
  *)
    usage
    echo "FAIL: '$PREFIX' is not a deployment namespace." >&2
    exit 2
    ;;
esac

# The pairing is the point of the check. Simulating the rehearsal role against the
# production namespace would report a wall of denials that are the boundary working, and
# simulating the production role against the rehearsal namespace would do the same in
# reverse; either way the output would say nothing about the apply about to be run.
if [ "$ROLE" != "${PREFIX}-deploy" ]; then
  usage
  echo "FAIL: $ROLE is not the deployment role of the $PREFIX namespace. Each role is asked only about its own." >&2
  exit 2
fi

# name | actions (comma separated) | sample resource ARN | context entries (semicolon separated key=value)
#
# One line per statement family. The sample ARNs are of this namespace and need not
# exist: `simulate-principal-policy` evaluates the policy, it does not call the service.
# The context entries are what make a tag-conditioned statement evaluate at all — an
# unsupplied condition key is an implicit deny, so a check that passed no context would
# report every EC2, KMS and CloudFront statement as denied and teach nothing.
IFS= read -r -d '' CHECK_GROUPS <<CHECK_TABLE || true
security group rules (denied 21 Sep)|ec2:AuthorizeSecurityGroupIngress,ec2:AuthorizeSecurityGroupEgress,ec2:RevokeSecurityGroupIngress,ec2:RevokeSecurityGroupEgress,ec2:ModifySecurityGroupRules|arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0000000000000000e|ec2:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the network|ec2:CreateVpc,ec2:CreateSubnet,ec2:CreateRouteTable,ec2:CreateRoute,ec2:AssociateRouteTable,ec2:CreateSecurityGroup,ec2:AttachInternetGateway,ec2:CreateTags,ec2:DeleteVpc|arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0000000000000000e|ec2:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
customer keys and their aliases (denied 21 Sep)|kms:CreateKey,kms:CreateAlias,kms:DeleteAlias,kms:DescribeKey,kms:EnableKeyRotation,kms:ScheduleKeyDeletion,kms:GenerateDataKey,kms:Encrypt,kms:Decrypt,kms:CreateGrant|arn:aws:kms:${REGION}:${ACCOUNT}:key/11111111-2222-4333-8444-555555555555|aws:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the key alias by name|kms:CreateAlias,kms:DeleteAlias,kms:UpdateAlias|arn:aws:kms:${REGION}:${ACCOUNT}:alias/${PREFIX}-example-journal|
an AWS-managed key of the account, which RDS describes on behalf of the caller (denied 21 Sep, run 35660873276)|kms:DescribeKey|arn:aws:kms:${REGION}:${ACCOUNT}:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee|
secrets manager entries (Access to KMS is not allowed, 21 Sep)|secretsmanager:CreateSecret,secretsmanager:DescribeSecret,secretsmanager:DeleteSecret,secretsmanager:TagResource|arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${PREFIX}-example/session-signing-key-AbCdEf|aws:ResourceTag/NamePrefix=${PREFIX}-example
alarms, including the two composites (denied 21 Sep)|cloudwatch:PutMetricAlarm,cloudwatch:PutCompositeAlarm,cloudwatch:DeleteAlarms,cloudwatch:DescribeAlarms,cloudwatch:TagResource|arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${PREFIX}-example-critical|
the composite alarms, which CloudWatch authorizes against alarm:* (denied 21 Sep)|cloudwatch:PutCompositeAlarm|arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:*|
the origin access control (denied 21 Sep)|cloudfront:CreateOriginAccessControl,cloudfront:GetOriginAccessControl,cloudfront:DeleteOriginAccessControl|*|
the distribution, and the guard's read of every one of them (review of PR 292)|cloudfront:CreateDistribution,cloudfront:TagResource,cloudfront:GetDistribution,cloudfront:UpdateDistribution,cloudfront:DeleteDistribution,cloudfront:ListDistributions|arn:aws:cloudfront::${ACCOUNT}:distribution/E111111111111|aws:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the master secret RDS creates on behalf of the caller, tagged with the instance ARN (refused 22 Sep, run 35679472666)|secretsmanager:CreateSecret,secretsmanager:TagResource|arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!db-11111111-2222-4333-8444-555555555555-AbCdEf|aws:RequestTag/aws:rds:primaryDBInstanceArn=arn:aws:rds:${REGION}:${ACCOUNT}:db:${PREFIX}-example-pg
the database, and the guard's read of every instance and manual snapshot (review of PR 292)|rds:CreateDBInstance,rds:ModifyDBInstance,rds:DeleteDBInstance,rds:AddTagsToResource,rds:DescribeDBInstances,rds:DescribeDBSnapshots|arn:aws:rds:${REGION}:${ACCOUNT}:db:${PREFIX}-example-pg|
the cluster, the services and the one-off tasks|ecs:CreateCluster,ecs:CreateService,ecs:UpdateService,ecs:DeleteService,ecs:RunTask,ecs:DescribeTasks,ecs:ListTasks|arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${PREFIX}-example-cluster|aws:RequestTag/NamePrefix=${PREFIX}-example
a task the teardown has to stop|ecs:StopTask,ecs:DescribeTasks|arn:aws:ecs:${REGION}:${ACCOUNT}:task/${PREFIX}-example-cluster/0000000000000000000000000000000e|
the task definitions|ecs:RegisterTaskDefinition,ecs:DeregisterTaskDefinition,ecs:DescribeTaskDefinition|*|aws:RequestTag/NamePrefix=${PREFIX}-example
the task roles|iam:CreateRole,iam:PutRolePolicy,iam:DeleteRolePolicy,iam:DeleteRole,iam:TagRole,iam:PassRole|arn:aws:iam::${ACCOUNT}:role/${PREFIX}-example-worker-task|
the load balancer and its listener|elasticloadbalancing:CreateLoadBalancer,elasticloadbalancing:CreateTargetGroup,elasticloadbalancing:CreateListener,elasticloadbalancing:AddTags|arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${PREFIX}-example-alb/1111111111111111|aws:RequestTag/NamePrefix=${PREFIX}-example
the log groups and their metric filters, and the guard's read of them by name (review of PR 292)|logs:CreateLogGroup,logs:PutRetentionPolicy,logs:AssociateKmsKey,logs:PutMetricFilter,logs:TagResource,logs:DeleteLogGroup,logs:DescribeLogGroups|arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/fss/${PREFIX}-example/worker|
the alert topic|sns:CreateTopic,sns:SetTopicAttributes,sns:Subscribe,sns:TagResource,sns:DeleteTopic|arn:aws:sns:${REGION}:${ACCOUNT}:${PREFIX}-example-alerts|
the daily alarm digest function (g99)|lambda:CreateFunction,lambda:GetFunction,lambda:UpdateFunctionCode,lambda:UpdateFunctionConfiguration,lambda:TagResource,lambda:DeleteFunction|arn:aws:lambda:${REGION}:${ACCOUNT}:function:${PREFIX}-example-alarm-digest|
the daily alarm digest schedule (g99)|scheduler:CreateSchedule,scheduler:GetSchedule,scheduler:UpdateSchedule,scheduler:DeleteSchedule|arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/${PREFIX}-example-alarm-digest|
the repositories|ecr:CreateRepository,ecr:DescribeRepositories,ecr:PutLifecyclePolicy,ecr:PutImageTagMutability|arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${PREFIX}-api|
the journal bucket, and the teardown of it (refused 21 Sep)|s3:CreateBucket,s3:PutBucketPolicy,s3:GetBucketPolicy,s3:DeleteBucketPolicy,s3:PutBucketVersioning,s3:PutBucketObjectLockConfiguration,s3:PutEncryptionConfiguration,s3:PutBucketPublicAccessBlock,s3:PutBucketOwnershipControls,s3:DeleteBucket|arn:aws:s3:::${PREFIX}-example-suppression-journal-${ACCOUNT}|
the identity, and the guard's read of everything tagged for the run (review of PR 292)|sts:GetCallerIdentity,tag:GetResources|*|
CHECK_TABLE

# The rehearsal's own row, appended rather than written above: only the rehearsal role
# holds ReadTheRdsManagedMasterSecretOfThisNamespacesInstance (the deploy stage assembles
# the database URL from that secret; production reads no secret value), and a group the
# production check must fail is a group that teaches nothing. Judged under the global tag
# key: the simulator refused this row under secretsmanager:ResourceTag/... on 22 September
# while allowing the request-tag rows beside it.
if [ "$PREFIX" = "fss-rh" ]; then
  CHECK_GROUPS="${CHECK_GROUPS}
the master secret once it exists, which the deploy stage describes (refused under the service tag key, 22 Sep)|secretsmanager:DescribeSecret|arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:rds!db-11111111-2222-4333-8444-555555555555-AbCdEf|aws:ResourceTag/aws:rds:primaryDBInstanceArn=arn:aws:rds:${REGION}:${ACCOUNT}:db:${PREFIX}-example-pg"
fi

# Some actions are authorized against a resource type that is not the group's sample, or
# against no resource at all, and `simulate-principal-policy` reports an implicit deny
# for a condition that cannot evaluate against the wrong type. The first real run of this
# check (21 September) reported ec2:CreateRoute denied against a VPC ARN, kms:CreateKey
# denied against a key ARN, and refused to simulate CloudFront creation together with
# CloudFront reads. Each override names the resource the action is actually judged on
# (`-` for none) and the context that statement needs.
override_for() { # override_for <action> -> "<resource>|<context>" or ""
  case "$1" in
    ec2:CreateRoute|ec2:ReplaceRoute|ec2:DeleteRoute|ec2:AssociateRouteTable|ec2:DisassociateRouteTable)
      printf '%s|%s\n' "arn:aws:ec2:${REGION}:${ACCOUNT}:route-table/rtb-0000000000000000e" "ec2:ResourceTag/NamePrefix=${PREFIX}-example" ;;
    ec2:CreateVpc|ec2:CreateInternetGateway|kms:CreateKey|cloudfront:CreateDistribution)
      printf '%s|%s\n' "-" "aws:RequestTag/NamePrefix=${PREFIX}-example" ;;
    # ECS judges each action on its own resource type (David's second run, 21 Sep): a service,
    # a task definition, a task, a container instance. Simulated against the cluster ARN, the
    # simulator answers implicit deny for all of them while the real calls are allowed.
    ecs:CreateService|ecs:UpdateService|ecs:DeleteService)
      printf '%s|%s\n' "arn:aws:ecs:${REGION}:${ACCOUNT}:service/${PREFIX}-example-cluster/${PREFIX}-example-api" "" ;;
    ecs:RunTask)
      printf '%s|%s\n' "arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${PREFIX}-example-migrate:1" "" ;;
    ecs:DescribeTasks|ecs:StopTask)
      printf '%s|%s\n' "arn:aws:ecs:${REGION}:${ACCOUNT}:task/${PREFIX}-example-cluster/0000000000000000000000000000000e" "" ;;
    ecs:ListTasks)
      printf '%s|%s\n' "arn:aws:ecs:${REGION}:${ACCOUNT}:container-instance/${PREFIX}-example-cluster/0000000000000000000000000000000e" "" ;;
    # A target group is its own resource type; the load balancer's ARN is the wrong one.
    elasticloadbalancing:CreateTargetGroup)
      printf '%s|%s\n' "arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${PREFIX}-example-api/2222222222222222" "aws:RequestTag/NamePrefix=${PREFIX}-example" ;;
    cloudwatch:PutCompositeAlarm)
      # CloudWatch authorizes a composite alarm against alarm:*, not its own name (David's
      # simulation of 21 September), so every group that names the action judges it there.
      printf '%s|%s\n' "arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:*" "" ;;
    *) printf '\n' ;;
  esac
}

if [ "${FSS_CHECK_ROLE_DRY_RUN:-}" = "1" ]; then
  echo "plan: simulate-principal-policy for arn:aws:iam::${ACCOUNT}:role/${ROLE} in the ${PREFIX} namespace"
  while IFS='|' read -r name actions resource context; do
    [ -n "$name" ] || continue
    echo "plan: $name"
    IFS=',' read -r -a action_list <<<"$actions"
    for action in "${action_list[@]}"; do
      action_resource="$resource"; action_context="$context"
      override="$(override_for "$action")"
      if [ -n "$override" ]; then action_resource="${override%%|*}"; action_context="${override#*|}"; fi
      echo "plan:   $action"
      if [ "$action_resource" = '*' ] || [ "$action_resource" = '-' ]; then
        echo "plan:     with no --resource-arns, because these actions take no resource"
      else
        echo "plan:     on $action_resource"
      fi
      [ -z "$action_context" ] || echo "plan:     with $action_context"
    done
  done <<<"$CHECK_GROUPS"
  echo "plan: no call was made"
  exit 0
fi

allowed=0
denied=0
evaluated=0

while IFS='|' read -r name actions resource context; do
  [ -n "$name" ] || continue
  echo "== $name"
  # One action per call. `simulate-principal-policy` refuses to evaluate, in one request,
  # actions that "require different authorization information" (a creation under a request
  # tag beside reads of an existing resource), and it reported exactly that for the
  # CloudFront group on 21 September. One call per action also lets each action be judged
  # against the resource type it is really authorized on.
  IFS=',' read -r -a action_list <<<"$actions"
  for action in "${action_list[@]}"; do
    action_resource="$resource"; action_context="$context"
    override="$(override_for "$action")"
    if [ -n "$override" ]; then action_resource="${override%%|*}"; action_context="${override#*|}"; fi

    simulate_arguments=(
      iam simulate-principal-policy
      --policy-source-arn "arn:aws:iam::${ACCOUNT}:role/${ROLE}"
      # The third column is what the simulator says it lacked: a condition key named in a
      # statement that no context entry supplied. The first denial of PR 168's read row
      # (22 September) was reported bare, and this is the line that would have explained it.
      --query 'EvaluationResults[].[EvalActionName,EvalDecision,to_string(MissingContextValues)]'
      --output text
      --action-names "$action"
    )
    # `*` or `-` in the resource column means "the API takes no resource", and the way to
    # say that to `simulate-principal-policy` is to pass no `--resource-arns` at all: the
    # parameter documents its own default as every resource, and `*` is not documented as
    # a legal element of the list.
    if [ "$action_resource" != '*' ] && [ "$action_resource" != '-' ]; then
      simulate_arguments+=(--resource-arns "$action_resource")
    fi
    if [ -n "$action_context" ]; then
      entries=()
      while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        entries+=("ContextKeyName=${entry%%=*},ContextKeyType=string,ContextKeyValues=${entry#*=}")
      done <<<"$(printf '%s\n' "$action_context" | tr ';' '\n')"
      simulate_arguments+=(--context-entries "${entries[@]}")
    fi

    results=$(command "$AWS" "${simulate_arguments[@]}")
    if [ -z "$(printf '%s' "$results" | tr -d '[:space:]')" ]; then
      echo "FAIL: the simulation returned no evaluation for: $action" >&2
      echo "      An empty answer is not a pass. Check the role name and the CLI credential." >&2
      exit 1
    fi
    while IFS=$'\t' read -r evaluated_action decision missing; do
      [ -n "$evaluated_action" ] || continue
      evaluated=$((evaluated + 1))
      case "$decision" in
        allowed)
          allowed=$((allowed + 1))
          echo "   allowed $evaluated_action"
          ;;
        *)
          denied=$((denied + 1))
          if [ "$action_resource" = '*' ] || [ "$action_resource" = '-' ]; then
            echo "   DENIED  $evaluated_action ($decision) with no resource"
          else
            echo "   DENIED  $evaluated_action ($decision) on $action_resource"
          fi
          case "${missing:-}" in
            ''|null|'[]'|None) ;;
            *) echo "           missing context: $missing" ;;
          esac
          ;;
      esac
    done <<<"$results"
  done
done <<<"$CHECK_GROUPS"

# A check that evaluated nothing is the vacuous pass this script exists to avoid: the
# floor is the number of actions the table names, so a CLI that silently answered for
# none of them is a failure rather than a clean run.
expected=$(printf '%s\n' "$CHECK_GROUPS" | awk -F'|' 'NF>1 {n=split($2,a,","); total+=n} END {print total+0}')
if [ "$evaluated" -lt "$expected" ]; then
  echo "FAIL: $expected actions were asked about and $evaluated were answered" >&2
  exit 1
fi

echo "$evaluated action(s) evaluated for $ROLE: $allowed allowed, $denied denied"
if [ "$denied" -gt 0 ]; then
  echo "FAIL: $denied action(s) the next apply needs are denied to $ROLE." >&2
  echo "      Re-render and re-put the policy: infra/scripts/policy.sh put $PREFIX (a production put" >&2
  echo "      adds --environment production); docs/greenfield/infra-apply-runbook.md 1.1." >&2
  exit 1
fi
}

# ===========================================================================
# put
# ===========================================================================
policy_put() {
  local prefix=${1:-} named='' allow_widening=0 aws account expected work
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --environment) named=${2:-}; shift 2 ;;
      --allow-widening) allow_widening=1; shift ;;
      *) echo "FAIL: policy.sh put does not take '$1'" >&2; exit 2 ;;
    esac
  done
  case "$prefix" in
    fss-rh) ;;
    fss-prod)
      if [ "$named" != production ]; then
        echo "FAIL: policy.sh put fss-prod replaces the whole inline policy of fss-prod-deploy, the role every production apply runs as; name production out loud: policy.sh put fss-prod --environment production" >&2
        exit 1
      fi
      ;;
    *)
      echo "FAIL: '$prefix' is not a deployment namespace. The two roles are fss-rh-deploy and fss-prod-deploy." >&2
      exit 2
      ;;
  esac
  if [ "$prefix" = fss-rh ] && [ -n "$named" ]; then
    echo "FAIL: --environment names production, and fss-rh is the rehearsal's role" >&2
    exit 2
  fi
  aws=${FSS_POLICY_AWS:-aws}
  expected=${FSS_POLICY_ACCOUNT_ID:-326255650484}
  account="$(command "$aws" sts get-caller-identity --query Account --output text)" \
    || { echo "FAIL: the session could not be read; nothing was put" >&2; exit 1; }
  if [ "$account" != "$expected" ]; then
    echo "FAIL: this session is in account ${account:-<none>}, and the document is rendered for $expected (FSS_POLICY_ACCOUNT_ID); a policy naming another account's resources is not this account's policy. Nothing was put." >&2
    exit 1
  fi
  work="$(mktemp -d "${TMPDIR:-/tmp}/fss-policy.XXXXXX")"
  # shellcheck disable=SC2064 # the path is fixed now
  trap "rm -rf '$work'" EXIT
  "$POLICY_SCRIPT" render "$prefix" --compact >"$work/document.json"
  # What the role holds now; a role without the policy yet answers NoSuchEntity.
  if ! command "$aws" iam get-role-policy --role-name "$prefix-deploy" --policy-name "$prefix-deploy-scope" \
    --query PolicyDocument --output json >"$work/before.json" 2>"$work/before.err"; then
    if grep -q '(NoSuchEntity)' "$work/before.err"; then
      echo 'null' >"$work/before.json"
    else
      cat "$work/before.err" >&2
      echo "FAIL: $prefix-deploy's current policy could not be read; nothing was put" >&2
      exit 1
    fi
  fi
  FSS_WORK="$work" FSS_PREFIX="$prefix" FSS_ALLOW_WIDENING="$allow_widening" python3 - <<'PY' || exit 1
# policy-put-changes: which Sids the put adds, removes and changes, and whether any of it
# widens the role. A widening is a refusal unless --allow-widening was given.
import json, os, sys
work = os.environ["FSS_WORK"]
held = json.load(open(os.path.join(work, "before.json")))
first = held is None
before = held or {"Statement": []}
after = json.load(open(os.path.join(work, "document.json")))
old = {s["Sid"]: s for s in before.get("Statement") or []}
new = {s["Sid"]: s for s in after.get("Statement") or []}
added = sorted(set(new) - set(old))
removed = sorted(set(old) - set(new))
changed = sorted(sid for sid in set(new) & set(old) if new[sid] != old[sid])
if first:
    print("{}-deploy-scope is not on {}-deploy yet; this put is the first one".format(
        os.environ["FSS_PREFIX"], os.environ["FSS_PREFIX"]))
elif not (added or removed or changed):
    print("the role already holds this document; putting it again changes nothing")
for label, sids in (("adds", added), ("removes", removed), ("changes", changed)):
    for sid in sids:
        print("{} {}".format(label, sid))


def listed(statement, field):
    value = statement.get(field)
    if value is None:
        return set()
    return set(value) if isinstance(value, list) else {value}


# Widening is judged against what the role holds, so a role that holds no policy yet has
# nothing to widen: the first put is the whole document by definition.
widening = []
for sid in [] if first else added:
    if new[sid].get("Effect") == "Allow":
        widening.append("adds the Allow {}".format(sid))
for sid in [] if first else removed:
    if old[sid].get("Effect") == "Deny":
        widening.append("removes the Deny {}".format(sid))
for sid in [] if first else changed:
    effect = new[sid].get("Effect")
    if effect != old[sid].get("Effect"):
        widening.append("changes the effect of {} from {} to {}".format(sid, old[sid].get("Effect"), effect))
        continue
    for field in ("Action", "Resource", "NotAction", "NotResource"):
        gained = listed(new[sid], field) - listed(old[sid], field)
        lost = listed(old[sid], field) - listed(new[sid], field)
        # An Allow grows by gaining; a Deny grows by losing. NotResource and NotAction are
        # the other way round, because they say what the statement does NOT cover.
        grew = lost if (effect == "Deny") != field.startswith("Not") else gained
        if grew:
            widening.append("{} of {} gains {}".format(field, sid, ", ".join(sorted(grew))))
    if not new[sid].get("Condition") and old[sid].get("Condition"):
        widening.append("{} loses its Condition".format(sid))
if widening and os.environ["FSS_ALLOW_WIDENING"] != "1":
    sys.exit("FAIL: this put would widen the role: {}. Nothing was put. A document that grants more "
             "than the role holds is a review, not a re-put: read it, and if the widening is the "
             "point, put it again with --allow-widening.".format("; ".join(widening)))
if widening:
    print("widening, put on purpose (--allow-widening): " + "; ".join(widening))
PY
  command "$aws" iam put-role-policy --role-name "$prefix-deploy" --policy-name "$prefix-deploy-scope" \
    --policy-document "file://$work/document.json" \
    || { echo "FAIL: IAM refused the put (above); $prefix-deploy keeps the policy it had" >&2; exit 1; }
  command "$aws" iam get-role-policy --role-name "$prefix-deploy" --policy-name "$prefix-deploy-scope" \
    --query PolicyDocument --output json >"$work/after.json" \
    || { echo "FAIL: the policy was put and could not be read back" >&2; exit 1; }
  if ! FSS_WORK="$work" python3 -c '
import json, os, sys
work = os.environ["FSS_WORK"]
put = json.load(open(os.path.join(work, "document.json")))
held = json.load(open(os.path.join(work, "after.json")))
sys.exit(0 if put == held else 1)
'; then
    echo "FAIL: $prefix-deploy holds a $prefix-deploy-scope that is not the document just put; read it with aws iam get-role-policy before any apply" >&2
    exit 1
  fi
  echo "put $prefix-deploy-scope on $prefix-deploy in account $account, and read it back unchanged"
  echo "next, before any apply: infra/scripts/policy.sh check $prefix-deploy $prefix"
}

# ===========================================================================
POLICY_SUBCOMMAND=${1:-}
shift || true
case "$POLICY_SUBCOMMAND" in
  render) policy_render "$@" ;;
  check) policy_check "$@" ;;
  put) policy_put "$@" ;;
  *) policy_usage ;;
esac
