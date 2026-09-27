# The role `.github/workflows/greenfield-google.yml` holds the Google root's state with
# (lane G-WIF).
#
# `infra/roots/production-google` keeps its Terraform state in this account's state
# bucket, under a key of its own (`infra/roots/production-google/backend.hcl`). Its
# identity in Google Cloud is federated from GitHub's OIDC token and needs no AWS
# credential, but the S3 backend does: something has to read and write that one state
# object and take its lock. This role is that something, and it is the whole of what it
# can do.
#
# It is not `fss-prod-ci-deploy`: that role deploys images and holds no state at all ("No
# state, no secrets, no IAM writes"), and this one holds one state object and can touch
# nothing else in AWS. It is not `fss-prod-deploy` either, which Terraform assumes and
# which may create and destroy the production namespace. The trust is the same shape as
# `ci_deploy`'s and reuses its issuer, its provider and the very same subject literal:
# one GitHub OIDC subject, this repository's `production-deploy` environment, which admits
# main alone.
#
# **The complete S3-backend set, and nothing else.** The state stanza of
# `infra/policies/deployment-role-policy.json.tftpl` (~354–398) is not on its own enough
# for a backend that takes the native S3 lock file as well as the DynamoDB row: the lock
# file is read and written and not only deleted, the list is scoped by prefix, the lock
# table is described, and the state object is encrypted with the production state KMS key.
# All six statements are here, scoped to the one key. No bucket, table or key deletion. No
# ECS, no ECR, no Secrets Manager, no IAM, and no `Resource: "*"` anywhere.

locals {
  ci_google_role_name = "${local.name_prefix}-ci-google"

  # The state object this role exists for: the bucket, key and lock table of
  # `infra/roots/production-google/backend.hcl`, written out here because the policy has
  # to name exactly them and a backend file is not readable from Terraform.
  ci_google_state_bucket = "callie-sourcing-tfstate-${local.aws_account_id}"
  ci_google_state_key    = "fss/greenfield/production-google/terraform.tfstate"
  ci_google_state_object = "arn:aws:s3:::callie-sourcing-tfstate-${local.aws_account_id}/fss/greenfield/production-google/terraform.tfstate"
  ci_google_lock_table   = "arn:aws:dynamodb:${local.aws_region}:${local.aws_account_id}:table/callie-sourcing-tflock"

  # The production state KMS key, a public identifier. `infra/scripts/policy.sh` carries
  # the same id as the default of FSS_POLICY_STATE_KMS_KEY_ID, and
  # `terraform init -backend-config="kms_key_id=<this ARN>"` is how both
  # `infra/roots/production/backend.hcl` and the Google root's document it.
  ci_google_state_kms_key = "arn:aws:kms:${local.aws_region}:${local.aws_account_id}:key/a321a083-4058-4130-b060-b950e4aa1404"

  ci_google_trust_policy = {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActionsInTheProductionDeployEnvironmentOnly"
      Effect    = "Allow"
      Principal = { Federated = local.ci_deploy_oidc_provider }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.ci_deploy_oidc_issuer}:aud" = "sts.amazonaws.com"
          "${local.ci_deploy_oidc_issuer}:sub" = local.ci_deploy_subject
        }
      }
    }]
  }

  ci_google_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadAndWriteTheGoogleRootsStateObject"
        Effect   = "Allow"
        Action   = ["s3:GetObject*", "s3:PutObject"]
        Resource = [local.ci_google_state_object]
      },
      {
        # `use_lockfile = true`: the backend writes this object to take the lock, reads it
        # back to say who holds it, and deletes it to release. All three, on it alone.
        Sid      = "TakeAndReleaseTheGoogleRootsStateLockFile"
        Effect   = "Allow"
        Action   = ["s3:GetObject*", "s3:PutObject", "s3:DeleteObject"]
        Resource = ["${local.ci_google_state_object}.tflock"]
      },
      {
        # The one statement whose resource is the bucket rather than the key, which is
        # what ListBucket takes; the prefix condition holds it to the key even so.
        Sid      = "ListOnlyTheGoogleRootsStateKey"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = ["arn:aws:s3:::${local.ci_google_state_bucket}"]
        Condition = {
          StringLike = { "s3:prefix" = local.ci_google_state_key }
        }
      },
      {
        # The backend is configured with both the native lock file and the legacy lock
        # table, so it takes both. Two rows: the state's and its checksum's.
        Sid      = "TakeAndReleaseTheGoogleRootsDynamoLockRows"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = [local.ci_google_lock_table]
        Condition = {
          "ForAllValues:StringLike" = {
            "dynamodb:LeadingKeys" = [
              "${local.ci_google_state_bucket}/${local.ci_google_state_key}",
              "${local.ci_google_state_bucket}/${local.ci_google_state_key}-md5",
            ]
          }
        }
      },
      {
        Sid      = "DescribeTheLockTable"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeTable"]
        Resource = [local.ci_google_lock_table]
      },
      {
        # The state object is encrypted with the production state key, which the workflow
        # names at init. Without this the first read is an AccessDenied from KMS.
        Sid      = "UseTerraformStateKmsKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*"]
        Resource = [local.ci_google_state_kms_key]
      },
    ]
  }
}

resource "aws_iam_role" "ci_google" {
  name               = local.ci_google_role_name
  description        = "CI holds infra/roots/production-google's Terraform state: one state object, its lock file, its two lock rows and the state key. Nothing else in AWS."
  assume_role_policy = jsonencode(local.ci_google_trust_policy)
  # One hour. A plan or an apply of four Pub/Sub objects and a handful of IAM bindings is
  # minutes; the deploy role's two hours are for two rollouts, which this never does.
  max_session_duration = 3600

  tags = {
    Name       = local.ci_google_role_name
    NamePrefix = local.name_prefix
  }
}

resource "aws_iam_role_policy" "ci_google" {
  name   = "${local.ci_google_role_name}-scope"
  role   = aws_iam_role.ci_google.id
  policy = jsonencode(local.ci_google_policy)
}
