# Production's suppression journal exempts nobody, and the opt-in is one variable.
#
# Offline only: a mocked apply, no backend, no credentials. Every ARN below is
# the AWS documentation example account, never a real one.
#
# ## Why this file exists
#
# `infra/modules/journal` denied deletion and lock weakening to `Principal *`
# with no exemption at all, which is right for production and was fatal for a
# rehearsal: David's fourth credentialed run (Actions 35628963637) applied and
# then could not tear its own journal bucket down. The fix is an exemption the
# *root* names, so the two environments can differ, and this is the half that
# asserts production did not quietly inherit the rehearsal's answer.
#
# David's decision 4 of 21 September 2026: GOVERNANCE mode, ten years, and
# removing the production journal stays an act of the account root unless he
# opts in. The variable is how he opts in — one `-var`, visible in the plan he
# reads — rather than a change to a module nobody would see.
#
# ## The vacuous-pass trap
#
# "Production exempts nobody" is true of a root that ignores the variable
# entirely, and it is also true of a module that lost the exemption code
# altogether — in which case the rehearsal would silently go back to leaving a
# bucket behind and this file would stay green. Closed by running the same root
# twice: once at its default, where no deny may carry an `ArnNotEquals`, and
# once with a principal named, where three of the four must. The second run is
# the positive control for the first.

# The database module waits five minutes between its key and its instance in a real
# apply; a mocked time provider makes that wait nothing here.
mock_provider "time" {}

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

  # These runs are applies, not plans, so the provider validates arguments a
  # plan leaves unknown: an unmocked target-group ARN is rejected by the
  # listener and by the service as "an invalid ARN: arn: invalid prefix". The
  # isolation tests next door are all plans and need none of this.
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/mock/1111111111111111"
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

# `override_during = apply` here, unlike the Google mock in `isolation.tftest.hcl`
# next door: nothing in this file asserts a value the Pub/Sub module produces,
# and `enable_gmail_push` is false in every run below, so the topic module has
# no instance at all.
mock_provider "google" {
  override_during = apply
}

variables {
  aws_account_id      = "123456789012"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname        = "api.example.invalid"
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
  enable_gmail_push   = false
}

run "production_exempts_nobody_from_the_journal_denies" {
  command = apply

  # The floor: a policy that could not be read would make everything below
  # vacuously true.
  assert {
    condition     = length(jsondecode(module.stack.journal_policy_json).Statement) >= 6
    error_message = "The production journal policy was read as having almost no statements; nothing below would mean anything."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      !can(statement.Condition.ArnNotEquals)
      if statement.Effect == "Deny"
    ])
    error_message = "Production's journal exempts nobody by default. An exemption that appeared here without David setting the variable would be the rehearsal's posture on the production record."
  }

  # Ten years and GOVERNANCE, which is the other half of decision 4.
  assert {
    condition     = module.stack.journal_object_lock.mode == "GOVERNANCE" && module.stack.journal_object_lock.retention_days == 3650
    error_message = "The production journal keeps suppression history for ten years in GOVERNANCE mode."
  }

  assert {
    condition     = module.stack.destroyable == false
    error_message = "A production stack is never destroyable, so the bucket's own force_destroy is false too."
  }
}

run "david_can_opt_in_to_a_production_teardown_by_naming_a_principal" {
  command = apply

  variables {
    journal_administrative_principal_arns = ["arn:aws:iam::123456789012:role/fss-prod-deploy"]
  }

  assert {
    condition = length([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      statement
      if statement.Effect == "Deny"
      && statement.Sid != "DenyUnencryptedTransport"
      && contains(try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], []), "arn:aws:iam::123456789012:role/fss-prod-deploy")
    ]) == 3
    error_message = "With a principal named, the three non-transport denies exempt it. Without this the run above would pass against a module that had lost the exemption entirely."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(module.stack.journal_policy_json).Statement :
      !can(statement.Condition.ArnNotEquals)
      if statement.Sid == "DenyUnencryptedTransport"
    ])
    error_message = "The transport deny applies to every principal, in production as in a rehearsal."
  }

  # Opting in does not make the stack destroyable, and it does not give the
  # production deployment role `s3:BypassGovernanceRetention` either: that is
  # denied outright in `infra/policies/deployment-role-policy.json.tftpl`, so
  # naming the role here is necessary and not sufficient.
  assert {
    condition     = module.stack.destroyable == false
    error_message = "Naming an administrative principal is not the same as making production destroyable."
  }
}
