# Production's apply replaces the service task definitions and never moves the
# running count (lane g70).
#
# Offline only: mocked applies, no backend, no credentials. Every ARN below is the
# AWS documentation example account, never a real one.
#
# ## Why this file exists
#
# The 25 September 04:41Z deploy of schema 16 applied first and stopped second: the
# apply pointed both running services at task definitions whose `{16,16}` range
# refused the schema-15 database, and `release-deploy.sh --schema-change` scaled
# them to zero only afterwards (`docs/greenfield/release.md` 8.0af). A schema
# release is now `release-stop.sh ... --environment production`, then the apply,
# then `release-deploy.sh --schema-change`, and the apply must not undo the stop.
#
# `infra/modules/cluster/tests/release_owns_the_count.tftest.hcl` asserts that at the
# module, starting from zero. This is production's own root, starting from the
# declared two and one, so it is the other direction: an apply that carries a new
# schema range and even `bootstrap = true` leaves a running production at its count.
# Until lane g70 `bootstrap = true` here scaled production to zero; now only the
# release scripts move the count, and a plan an operator reads shows the task
# definitions change and the services' counts not change.
#
# The mocks and variables are `journal_teardown.tftest.hcl`'s, for the reason given
# there: these runs are applies, and an apply validates arguments a plan leaves
# unknown.

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

  # The same, for the daily alarm digest's schedule target (lane g99).
  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:mock-alarm-digest"
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
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname        = "api.example.invalid"
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
}

run "production_is_created_at_its_declared_counts" {
  command = apply

  assert {
    condition = (module.stack.service_shape.api.desired_count == 2
    && module.stack.service_shape.worker.desired_count == 1)
    error_message = "The starting point: production created at its declared two API tasks and one worker."
  }
}

run "a_later_production_apply_moves_the_task_definitions_and_not_the_counts" {
  command = apply

  variables {
    api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000011"
    worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000012"
    api_schema_range    = { min = 16, max = 16 }
    worker_schema_range = { min = 16, max = 16 }
    # The strongest case: the variable that used to be the outage. It decides the
    # count a service is created at, and these services already exist.
    bootstrap = true
  }

  assert {
    condition = (module.stack.service_shape.api.desired_count == 2
    && module.stack.service_shape.worker.desired_count == 1)
    error_message = "A production apply moved a running service's count. The count is release-stop.sh's and release-deploy.sh's after the first apply: both services must carry ignore_changes = [desired_count]."
  }

  assert {
    condition     = module.stack.deployment_plan.bootstrap == true
    error_message = "The positive control: this run really did pass bootstrap = true, which before lane g70 scaled production to zero."
  }

  assert {
    condition = (module.stack.api_environment["FSS_SCHEMA_MIN"] == "16"
    && module.stack.worker_environment["FSS_SCHEMA_MAX"] == "16")
    error_message = "The apply still delivers the release's schema ranges to the service task definitions; that is the rolling path."
  }
}
