# Structural isolation of the rehearsal root from production.
#
# Offline only: every run is a mocked plan, there is no backend and there are
# no credentials. The account id and every ARN below are the AWS documentation
# example values, never real ones.

mock_provider "aws" {
  override_during = plan

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

mock_provider "google" {
  override_during = plan
}

variables {
  aws_account_id      = "123456789012"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname        = "rehearsal.example.invalid"
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-rh-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
}

run "the_run_is_rehearsal_and_destroyable" {
  command = plan

  assert {
    condition     = output.environment == "rehearsal"
    error_message = "This root is always rehearsal."
  }

  assert {
    condition     = output.destroyable == true
    error_message = "A rehearsal environment must be able to disappear."
  }

  assert {
    condition     = startswith(output.name_prefix, "fss-rh-")
    error_message = "A rehearsal run lives in the fss-rh- namespace."
  }

  assert {
    condition     = startswith(output.deployment_role_name, "fss-rh-")
    error_message = "The rehearsal deployment role is its own role, scoped to fss-rh-*."
  }
}

run "no_name_this_run_claims_can_be_a_production_name" {
  command = plan

  assert {
    condition     = length(output.resource_names) > 25
    error_message = "The inventory must actually cover the stack; a nearly empty list proves nothing."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : strcontains(name, output.name_prefix)])
    error_message = "Every name this run claims must carry the run namespace."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : !strcontains(name, "fss-prod")])
    error_message = "No name this run claims may fall inside the production namespace."
  }

}

run "a_second_run_shares_no_name_with_the_first" {
  command = plan

  variables {
    name_prefix = "fss-rh-second"
  }

  assert {
    condition     = alltrue([for name in output.resource_names : strcontains(name, "fss-rh-second")])
    error_message = "A second concurrent rehearsal run must claim its own namespace."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : !strcontains(name, "fss-rh-default-")])
    error_message = "Two rehearsal runs must not collide."
  }
}

# The acceptance case: the isolation test fails if someone sets the rehearsal
# prefix equal to production's.
run "the_production_prefix_is_refused" {
  command = plan

  variables {
    name_prefix = "fss-prod"
  }

  expect_failures = [var.name_prefix]
}

run "a_prefix_that_merely_starts_like_production_is_refused" {
  command = plan

  variables {
    name_prefix = "fss-production-copy"
  }

  expect_failures = [var.name_prefix]
}

run "the_production_deployment_role_is_refused" {
  command = plan

  variables {
    deployment_role_name = "fss-prod-deploy"
  }

  expect_failures = [var.deployment_role_name]
}

# The same topology answers, at one API task and one worker.
#
# A rehearsal that ran on a different architecture, a different instance class or a
# different task size would deploy the production digests onto a machine production
# never uses, and 16.2's "the exact immutable artifacts intended for production" would
# be true of the bytes and false of everything around them.
run "the_topology_answers_are_the_rehearsal_defaults_at_one_plus_one" {
  command = plan

  assert {
    condition = (module.stack.task_runtime_platform.api.cpu_architecture == "ARM64"
    && module.stack.task_runtime_platform.worker.cpu_architecture == "ARM64")
    error_message = "The rehearsal must deploy the arm64 images on ARM64 Fargate, exactly as production will."
  }

  assert {
    condition     = module.stack.database_shape.instance_class == "db.t4g.small"
    error_message = "The same instance class as production, so the restore drill measures something production-shaped."
  }

  assert {
    condition     = module.stack.database_shape.multi_az
    error_message = "Multi-AZ, because Appendix E step 1 restores a Multi-AZ instance in production and that is the step the run is timed by."
  }

  assert {
    condition = (module.stack.service_shape.api.cpu == "512"
      && module.stack.service_shape.api.memory == "1024"
      && module.stack.service_shape.worker.cpu == "512"
    && module.stack.service_shape.worker.memory == "1024")
    error_message = "The same 0.5 vCPU / 1 GiB task size as production."
  }

  assert {
    condition = (module.stack.service_shape.api.desired_count == 1
    && module.stack.service_shape.worker.desired_count == 1)
    error_message = "One of each: the shapes are production's, the counts are not."
  }

  assert {
    condition     = module.stack.container_insights == "disabled" && module.stack.waf_enabled == false
    error_message = "The billed-per-metric options stay off in rehearsal too."
  }

  assert {
    condition = (module.stack.database_shape.performance_insights_enabled == false
    && module.stack.database_shape.monitoring_interval == 0)
    error_message = "Performance Insights and Enhanced Monitoring stay off."
  }
}

run "an_architecture_that_is_not_one_of_the_two_is_refused" {
  command = plan

  variables {
    cpu_architecture = "aarch64"
  }

  expect_failures = [var.cpu_architecture]
}

run "rehearsal_may_be_small_and_single_az" {
  command = plan

  # The default is Multi-AZ (the run above), because the restore drill is the
  # expensive step and it must restore what production would. Single-AZ stays
  # *available* for a run investigating something else, and this asserts the
  # capability rather than the default: production has a stack precondition
  # refusing single-AZ, and rehearsal deliberately does not.
  variables {
    database_multi_az = false
  }

  assert {
    condition     = module.stack.database_shape.multi_az == false
    error_message = "A rehearsal run may still ask for single-AZ; only production refuses it."
  }

  assert {
    condition     = module.stack.destroyable
    error_message = "Rehearsal turns deletion protection off across the stack."
  }

  assert {
    condition     = output.journal_object_lock.mode == "GOVERNANCE" && output.journal_object_lock.retention_days == 1
    error_message = "A rehearsal journal keeps object lock honest but short enough that the bucket can be removed."
  }
}

run "both_services_are_told_the_workspace_domain" {
  command = plan

  # The same Workspace, because the rehearsal signs in with the same Google
  # OIDC client (its second registered redirect URI). The environment carries
  # it rather than a field inside an operator-pasted secret.
  assert {
    condition     = module.stack.api_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
    error_message = "The rehearsal API restricts sign-in to the Callie Workspace domain."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
    error_message = "The rehearsal worker reads the same domain."
  }

  # Push is off in this run, and the variable is still present and empty rather
  # than absent: a bootstrap that reads it gets "not configured", not a
  # `KeyError` at plan time and a surprise at boot.
  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"] == ""
    error_message = "With push off the topic is empty, not missing."
  }
}

run "gmail_push_cannot_be_turned_on_without_its_own_project" {
  command = plan

  variables {
    enable_gmail_push = true
    gcp_project_id    = ""
  }

  expect_failures = [var.gcp_project_id]
}
