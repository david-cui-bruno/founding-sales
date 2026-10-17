# Read-only release preparation; no resource application, secret-value read or IAM write.
# The only writes are the existing Terraform backend's locks, scoped to its one key.
locals {
  ci_plan_state_bucket = "callie-sourcing-tfstate-326255650484"
  ci_plan_state_key    = "fss/greenfield/production/terraform.tfstate"
  ci_plan_state_arn    = "arn:aws:s3:::${local.ci_plan_state_bucket}/${local.ci_plan_state_key}"
  ci_plan_metadata = [for statement in jsondecode(templatefile("../../policies/deployment-role-policy.json.tftpl", {
    name_prefix         = local.name_prefix
    aws_account_id      = local.aws_account_id
    aws_region          = local.aws_region
    certificate_arn     = local.certificate_arn
    deployment_role_arn = local.deployment_role_arn
    lock_table          = "callie-sourcing-tflock"
    state_bucket        = local.ci_plan_state_bucket
    state_key_glob      = local.ci_plan_state_key
    state_kms_key_arn   = local.ci_google_state_kms_key
  })).Statement : statement if statement.Sid == "AccountMetadata"]
  ci_plan_policy = {
    Version = "2012-10-17"
    Statement = concat(local.ci_plan_metadata, [
      {
        Sid      = "ReadProductionRoleMetadata"
        Effect   = "Allow"
        Action   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListRoleTags"]
        Resource = ["arn:aws:iam::${local.aws_account_id}:role/${local.name_prefix}-*"]
      },
      {
        Sid      = "ReadProductionSecretMetadata"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy"]
        Resource = ["arn:aws:secretsmanager:${local.aws_region}:${local.aws_account_id}:secret:${local.name_prefix}/*"]
      },
      {
        Sid      = "ReadProductionBucketConfiguration"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketTagging", "s3:GetBucketPolicy", "s3:GetBucketAcl", "s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration", "s3:GetEncryptionConfiguration", "s3:GetBucketPublicAccessBlock", "s3:GetBucketOwnershipControls", "s3:GetLifecycleConfiguration", "s3:GetBucketCors", "s3:GetBucketLogging", "s3:GetBucketWebsite", "s3:GetReplicationConfiguration", "s3:GetAccelerateConfiguration", "s3:GetBucketRequestPayment"]
        Resource = ["arn:aws:s3:::${local.name_prefix}-*"]
      },
      {
        Sid       = "ReadTaggedProductionKeyConfiguration"
        Effect    = "Allow"
        Action    = ["kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"]
        Resource  = ["arn:aws:kms:${local.aws_region}:${local.aws_account_id}:key/*"]
        Condition = { StringEquals = { "aws:ResourceTag/NamePrefix" = local.name_prefix } }
      },
      {
        Sid      = "ReadProductionImageConfiguration"
        Effect   = "Allow"
        Action   = ["ecr:GetLifecyclePolicy", "ecr:GetRepositoryPolicy"]
        Resource = ["arn:aws:ecr:${local.aws_region}:${local.aws_account_id}:repository/${local.name_prefix}-*"]
      },
      {
        Sid      = "ReadProductionDigestMetadata"
        Effect   = "Allow"
        Action   = ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionCodeSigningConfig", "lambda:ListTags", "lambda:ListVersionsByFunction"]
        Resource = ["arn:aws:lambda:${local.aws_region}:${local.aws_account_id}:function:${local.name_prefix}-*"]
      },
      {
        Sid      = "ReadProductionDigestSchedule"
        Effect   = "Allow"
        Action   = ["scheduler:GetSchedule"]
        Resource = ["arn:aws:scheduler:${local.aws_region}:${local.aws_account_id}:schedule/default/${local.name_prefix}-*"]
      },
      {
        Sid      = "ReadProductionAlertMetadata"
        Effect   = "Allow"
        Action   = ["sns:GetTopicAttributes", "sns:GetSubscriptionAttributes", "sns:ListTagsForResource"]
        Resource = ["arn:aws:sns:${local.aws_region}:${local.aws_account_id}:${local.name_prefix}-*", "arn:aws:sns:${local.aws_region}:${local.aws_account_id}:${local.name_prefix}-*:*"]
      }
    ], jsondecode(file("${path.module}/../../policies/production-backend-plan.json")).Statement)
  }
}
resource "aws_iam_role" "ci_plan" {
  name        = "${local.name_prefix}-ci-plan"
  description = "Read-only production saved-plan preparation with existing backend locks only."
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.ci_deploy_oidc_provider }
      Condition = { StringEquals = {
        "${local.ci_deploy_oidc_issuer}:aud" = "sts.amazonaws.com"
        "${local.ci_deploy_oidc_issuer}:sub" = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-plan"
      } }
    }]
  })
  max_session_duration = 3600
  tags                 = { Name = "${local.name_prefix}-ci-plan", NamePrefix = local.name_prefix }
}
resource "aws_iam_role_policy" "ci_plan" {
  name   = "${local.name_prefix}-ci-plan-scope"
  role   = aws_iam_role.ci_plan.id
  policy = jsonencode(local.ci_plan_policy)
}
output "ci_plan_role_arn" {
  description = "Read-only production-plan identity: FSS_PRODUCTION_PLAN_ROLE_ARN."
  value       = aws_iam_role.ci_plan.arn
}
