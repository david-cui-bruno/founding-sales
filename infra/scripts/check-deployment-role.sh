#!/usr/bin/env bash
# Ask IAM whether a deployment role may do what the next apply will ask of it.
#
#   infra/scripts/check-deployment-role.sh fss-rh-deploy   fss-rh
#   infra/scripts/check-deployment-role.sh fss-prod-deploy fss-prod
#
# Read-only. The one AWS call it makes is `aws iam simulate-principal-policy`, which
# evaluates a policy without performing anything, and it is run against **sample** ARNs
# of the namespace rather than against resources that exist. Run it before any apply:
# the fourth credentialed rehearsal (Actions run 35628963637, 21 September 2026) spent
# an apply and a failed teardown discovering six classes of denial that this command
# answers in a few seconds.
#
# Every action of that run is in the table below, plus at least one action per service
# the Terraform tree uses, plus the actions the release scripts make outside Terraform.
# `infra/policies/terraform-resource-actions.json` is the full map and
# `test/release/deploymentRolePolicy.check.ts` is what keeps the two in step.
#
# Exit status is the answer: 0 when every action is allowed, 1 when any is not, 2 when
# the arguments are wrong. A run that evaluated nothing fails; "no denials" and "no
# results" must not look the same.
#
#   FSS_CHECK_ROLE_DRY_RUN=1   print the plan, make no call, exit 0
#   FSS_CHECK_ROLE_AWS=<path>  the CLI to use, for the offline test's stub
#   FSS_CHECK_ROLE_ACCOUNT_ID  default 326255650484
#   FSS_CHECK_ROLE_REGION      default us-east-1

set -euo pipefail

ROLE=${1:-}
PREFIX=${2:-}
ACCOUNT=${FSS_CHECK_ROLE_ACCOUNT_ID:-326255650484}
REGION=${FSS_CHECK_ROLE_REGION:-us-east-1}
AWS=${FSS_CHECK_ROLE_AWS:-aws}

usage() {
  echo "usage: $(basename "$0") <fss-rh-deploy|fss-prod-deploy> <fss-rh|fss-prod>" >&2
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
CHECK_GROUPS=$(
  cat <<CHECK_TABLE
security group rules (denied 21 Sep)|ec2:AuthorizeSecurityGroupIngress,ec2:AuthorizeSecurityGroupEgress,ec2:RevokeSecurityGroupIngress,ec2:RevokeSecurityGroupEgress,ec2:ModifySecurityGroupRules|arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0000000000000000e|ec2:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the network|ec2:CreateVpc,ec2:CreateSubnet,ec2:CreateRouteTable,ec2:CreateRoute,ec2:AssociateRouteTable,ec2:CreateSecurityGroup,ec2:AttachInternetGateway,ec2:CreateTags,ec2:DeleteVpc|arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0000000000000000e|ec2:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
customer keys and their aliases (denied 21 Sep)|kms:CreateKey,kms:CreateAlias,kms:DeleteAlias,kms:DescribeKey,kms:EnableKeyRotation,kms:ScheduleKeyDeletion,kms:GenerateDataKey,kms:Decrypt,kms:CreateGrant|arn:aws:kms:${REGION}:${ACCOUNT}:key/11111111-2222-4333-8444-555555555555|aws:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the key alias by name|kms:CreateAlias,kms:DeleteAlias,kms:UpdateAlias|arn:aws:kms:${REGION}:${ACCOUNT}:alias/${PREFIX}-example-journal|
secrets manager entries (Access to KMS is not allowed, 21 Sep)|secretsmanager:CreateSecret,secretsmanager:DescribeSecret,secretsmanager:DeleteSecret,secretsmanager:TagResource|arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${PREFIX}-example/session-signing-key-AbCdEf|aws:ResourceTag/NamePrefix=${PREFIX}-example
alarms, including the two composites (denied 21 Sep)|cloudwatch:PutMetricAlarm,cloudwatch:PutCompositeAlarm,cloudwatch:DeleteAlarms,cloudwatch:DescribeAlarms,cloudwatch:TagResource|arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${PREFIX}-example-critical|
the origin access control (denied 21 Sep)|cloudfront:CreateOriginAccessControl,cloudfront:GetOriginAccessControl,cloudfront:DeleteOriginAccessControl|*|
the distribution|cloudfront:CreateDistributionWithTags,cloudfront:GetDistribution,cloudfront:UpdateDistribution,cloudfront:DeleteDistribution|arn:aws:cloudfront::${ACCOUNT}:distribution/E111111111111|aws:ResourceTag/NamePrefix=${PREFIX}-example;aws:RequestTag/NamePrefix=${PREFIX}-example
the database|rds:CreateDBInstance,rds:ModifyDBInstance,rds:DeleteDBInstance,rds:AddTagsToResource,rds:RestoreDBInstanceToPointInTime|arn:aws:rds:${REGION}:${ACCOUNT}:db:${PREFIX}-example-pg|
the database snapshots the drill leaves|rds:CreateDBSnapshot,rds:DeleteDBSnapshot|arn:aws:rds:${REGION}:${ACCOUNT}:snapshot:${PREFIX}-example-pg-drill|
the cluster, the services and the one-off tasks|ecs:CreateCluster,ecs:CreateService,ecs:UpdateService,ecs:DeleteService,ecs:RunTask,ecs:DescribeTasks,ecs:ListTasks|arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${PREFIX}-example-cluster|aws:RequestTag/NamePrefix=${PREFIX}-example
a task the teardown has to stop|ecs:StopTask,ecs:DescribeTasks|arn:aws:ecs:${REGION}:${ACCOUNT}:task/${PREFIX}-example-cluster/0000000000000000000000000000000e|
the task definitions|ecs:RegisterTaskDefinition,ecs:DeregisterTaskDefinition,ecs:DescribeTaskDefinition|*|aws:RequestTag/NamePrefix=${PREFIX}-example
the task roles|iam:CreateRole,iam:PutRolePolicy,iam:DeleteRolePolicy,iam:DeleteRole,iam:TagRole,iam:PassRole|arn:aws:iam::${ACCOUNT}:role/${PREFIX}-example-worker-task|
the load balancer and its listener|elasticloadbalancing:CreateLoadBalancer,elasticloadbalancing:CreateTargetGroup,elasticloadbalancing:CreateListener,elasticloadbalancing:AddTags|arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${PREFIX}-example-alb/1111111111111111|aws:RequestTag/NamePrefix=${PREFIX}-example
the log groups and their metric filters|logs:CreateLogGroup,logs:PutRetentionPolicy,logs:AssociateKmsKey,logs:PutMetricFilter,logs:TagResource,logs:DeleteLogGroup|arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/fss/${PREFIX}-example/worker|
the alert topic|sns:CreateTopic,sns:SetTopicAttributes,sns:Subscribe,sns:TagResource,sns:DeleteTopic|arn:aws:sns:${REGION}:${ACCOUNT}:${PREFIX}-example-alerts|
the repositories|ecr:CreateRepository,ecr:DescribeRepositories,ecr:PutLifecyclePolicy,ecr:PutImageTagMutability|arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${PREFIX}-api|
the journal bucket, and the teardown of it (refused 21 Sep)|s3:CreateBucket,s3:PutBucketPolicy,s3:GetBucketPolicy,s3:DeleteBucketPolicy,s3:PutBucketVersioning,s3:PutBucketObjectLockConfiguration,s3:PutEncryptionConfiguration,s3:PutBucketPublicAccessBlock,s3:PutBucketOwnershipControls,s3:DeleteBucket|arn:aws:s3:::${PREFIX}-example-suppression-journal-${ACCOUNT}|
the identity and the production inventory|sts:GetCallerIdentity,tag:GetResources|*|
CHECK_TABLE
)

if [ "${FSS_CHECK_ROLE_DRY_RUN:-}" = "1" ]; then
  echo "plan: simulate-principal-policy for arn:aws:iam::${ACCOUNT}:role/${ROLE} in the ${PREFIX} namespace"
  while IFS='|' read -r name actions resource context; do
    [ -n "$name" ] || continue
    echo "plan: $name"
    printf '%s\n' "$actions" | tr ',' '\n' | sed 's/^/plan:   /'
    echo "plan:   on $resource"
    [ -z "$context" ] || echo "plan:   with $context"
  done <<<"$CHECK_GROUPS"
  echo "plan: no call was made"
  exit 0
fi

allowed=0
denied=0
evaluated=0

while IFS='|' read -r name actions resource context; do
  [ -n "$name" ] || continue

  simulate_arguments=(
    iam simulate-principal-policy
    --policy-source-arn "arn:aws:iam::${ACCOUNT}:role/${ROLE}"
    --resource-arns "$resource"
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]'
    --output text
  )
  # `--action-names` takes a list; the shell splits the comma-separated column.
  IFS=',' read -r -a action_list <<<"$actions"
  simulate_arguments+=(--action-names "${action_list[@]}")

  if [ -n "$context" ]; then
    entries=()
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      entries+=("ContextKeyName=${entry%%=*},ContextKeyType=string,ContextKeyValues=${entry#*=}")
    done <<<"$(printf '%s\n' "$context" | tr ';' '\n')"
    simulate_arguments+=(--context-entries "${entries[@]}")
  fi

  echo "== $name"
  results=$(command "$AWS" "${simulate_arguments[@]}")
  if [ -z "$(printf '%s' "$results" | tr -d '[:space:]')" ]; then
    echo "FAIL: the simulation returned no evaluation for: $actions" >&2
    echo "      An empty answer is not a pass. Check the role name and the CLI credential." >&2
    exit 1
  fi

  while IFS=$'\t' read -r action decision; do
    [ -n "$action" ] || continue
    evaluated=$((evaluated + 1))
    case "$decision" in
      allowed)
        allowed=$((allowed + 1))
        echo "   allowed $action"
        ;;
      *)
        denied=$((denied + 1))
        echo "   DENIED  $action ($decision) on $resource"
        ;;
    esac
  done <<<"$results"
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
  echo "      Re-render and re-put the policy: infra/scripts/render-deployment-role-policy.sh $PREFIX" >&2
  echo "      The commands are in docs/greenfield/infra-apply-runbook.md 1.1." >&2
  exit 1
fi
