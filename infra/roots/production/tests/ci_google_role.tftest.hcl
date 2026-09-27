# The role CI holds the Google root's Terraform state with (lane G-WIF).
#
# Offline only: every run is a mocked plan, there is no backend and there are no
# credentials. Modelled on `ci_deploy_role.tftest.hcl`, and it reads the same way.
#
# ## What is asserted, and the vacuous passes it closes
#
# **The trust.** One statement, compared whole, exactly as the CI deploy role's is: this
# account's GitHub OIDC provider, `AssumeRoleWithWebIdentity` alone, and `StringEquals`
# alone on the audience and on the one `production-deploy` subject. Comparing the
# condition as a map rather than key by key refuses a `StringLike` beside it, which is how
# a wildcard subject gets in, and refuses a second subject.
#
# **One state object.** Every resource the policy names is checked against a list of four
# strings — the Google root's state object, its lock file, the bucket, the lock table and
# the state key — so a statement that reached the production root's own state, a rehearsal
# key or a second bucket is red here. The distinct actions are compared with an exact
# list, so an ECS, ECR, Secrets Manager or IAM action added beside them is red too, and
# the statement count is asserted because a test over no statements passes every
# `alltrue`.
#
# **The bucket is the one broad resource, and it is conditioned.** `s3:ListBucket` takes a
# bucket and not a key, so the bucket ARN appears once; the statement that carries it
# holds it to this root's key with `s3:prefix`. There is no `Resource: "*"` at all.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-bucket"
      id                          = "mock-bucket"
      bucket_regional_domain_name = "mock-bucket.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/1111111111111111"
      dns_name = "mock-1111111111.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:mock-alerts"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E111111111111"
      id          = "E111111111111"
      domain_name = "d111111111111.cloudfront.net"
    }
  }
}

variables {
  api_image           = "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "326255650484.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 16, max = 16 }
  worker_schema_range = { min = 16, max = 16 }
}

run "the_state_role_is_a_third_role_with_an_hour_long_session" {
  command = plan

  assert {
    condition = (
      aws_iam_role.ci_google.name == "fss-prod-ci-google"
      && aws_iam_role.ci_google.name != aws_iam_role.ci_deploy.name
      && aws_iam_role.ci_google.name != output.deployment_role_name
      && aws_iam_role.ci_google.max_session_duration == 3600
      && aws_iam_role_policy.ci_google.name == "fss-prod-ci-google-scope"
    )
    error_message = "The role that holds the Google root's state is neither the role CI deploys with nor the role Terraform assumes, and its session is the hour a plan and an apply of four Pub/Sub objects take."
  }
}

run "the_state_role_trusts_the_same_one_github_subject_as_the_deploy_role" {
  command = plan

  assert {
    condition = jsondecode(aws_iam_role.ci_google.assume_role_policy).Statement == [{
      Sid       = "GitHubActionsInTheProductionDeployEnvironmentOnly"
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::326255650484:oidc-provider/token.actions.githubusercontent.com" }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:david-cui-bruno@196666240/founding-sales@1351406527:environment:production-deploy"
        }
      }
    }]
    error_message = "The trust is one statement, compared whole: this account's GitHub OIDC provider alone, AssumeRoleWithWebIdentity alone — so no AWS principal can chain into it — and StringEquals alone on the audience and this repository's production-deploy subject, the same literal ci_deploy.tf pins and the same one infra/roots/production-google admits in Google Cloud. A StringLike beside it would be a pattern, and a pattern is how a wildcard subject gets in."
  }

  assert {
    condition     = jsondecode(aws_iam_role.ci_google.assume_role_policy).Statement == jsondecode(aws_iam_role.ci_deploy.assume_role_policy).Statement
    error_message = "The two CI roles trust exactly the same subject: one GitHub environment admits both, and widening one without the other is not a thing that can happen quietly."
  }
}

run "the_policy_is_the_backend_set_for_one_state_object_and_nothing_else" {
  command = plan

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.ci_google.policy).Statement) == 6
      && alltrue([for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement : statement.Effect == "Allow"])
      && sort([for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement : statement.Sid]) == tolist([
        "DescribeTheLockTable",
        "ListOnlyTheGoogleRootsStateKey",
        "ReadAndWriteTheGoogleRootsStateObject",
        "TakeAndReleaseTheGoogleRootsDynamoLockRows",
        "TakeAndReleaseTheGoogleRootsStateLockFile",
        "UseTerraformStateKmsKey",
      ])
    )
    error_message = "Six Allow statements, named: the state object, its lock file, the prefixed list, the two lock rows, the table describe and the state key. An assertion over no statements would pass anything, so they are counted."
  }

  assert {
    condition = sort(distinct(flatten([for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement : statement.Action]))) == tolist([
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "s3:DeleteObject",
      "s3:GetObject*",
      "s3:ListBucket",
      "s3:PutObject",
    ])
    error_message = "Exactly what Terraform's S3 backend does with one state object: read and write it, take, read and release its lock file and its two lock rows, describe the table, and use the state key. No ECS, no ECR, no Secrets Manager, no IAM, and nothing that deletes a bucket, a table or a key."
  }

  assert {
    condition = alltrue(flatten([
      for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement : [
        for resource in statement.Resource : contains([
          "arn:aws:s3:::callie-sourcing-tfstate-326255650484/fss/greenfield/production-google/terraform.tfstate",
          "arn:aws:s3:::callie-sourcing-tfstate-326255650484/fss/greenfield/production-google/terraform.tfstate.tflock",
          "arn:aws:s3:::callie-sourcing-tfstate-326255650484",
          "arn:aws:dynamodb:us-east-1:326255650484:table/callie-sourcing-tflock",
          "arn:aws:kms:us-east-1:326255650484:key/a321a083-4058-4130-b060-b950e4aa1404",
        ], resource)
      ]
    ]))
    error_message = "Every resource named is the Google root's own state object, its lock file, the bucket the list needs, the lock table or the production state key. Never the production root's state, never a rehearsal key, never a second bucket."
  }

  assert {
    condition = (
      !can(regex("fss/greenfield/production/|fss/greenfield/rehearsal|ecs:|ecr:|secretsmanager:|iam:|:role/|DeleteBucket|DeleteTable|ScheduleKeyDeletion", aws_iam_role_policy.ci_google.policy))
      && !strcontains(aws_iam_role_policy.ci_google.policy, "\"*\"")
    )
    error_message = "The policy names no other state key, no other service, no role and nothing that deletes the bucket, the table or the key, and there is no Resource * anywhere in it."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement :
      [statement.Resource, statement.Condition] if contains(statement.Action, "s3:ListBucket")
      ] == [[
        ["arn:aws:s3:::callie-sourcing-tfstate-326255650484"],
        { StringLike = { "s3:prefix" = "fss/greenfield/production-google/terraform.tfstate" } },
    ]]
    error_message = "The bucket ARN appears once, on the list ListBucket takes a bucket for, and that statement is held to this root's key by s3:prefix. No other statement names the bucket alone."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.ci_google.policy).Statement :
      statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] if contains(statement.Action, "dynamodb:PutItem")
      ] == [[
        "callie-sourcing-tfstate-326255650484/fss/greenfield/production-google/terraform.tfstate",
        "callie-sourcing-tfstate-326255650484/fss/greenfield/production-google/terraform.tfstate-md5",
    ]]
    error_message = "The lock rows this role may write are the Google root's two and no others: the shared table holds production's and every rehearsal's beside them."
  }
}
