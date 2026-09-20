# Structural isolation of the production root from every rehearsal run, and
# the production postures that are not deployment-time choices.
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

  mock_resource "google_service_account" {
    defaults = {
      email = "fss-prod-gmail-push@fss-prod-example.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_pubsub_topic" {
    defaults = {
      id = "projects/fss-prod-example/topics/fss-prod-gmail-push"
    }
  }
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

run "production_is_named_fss_prod_and_is_never_destroyable" {
  command = plan

  assert {
    condition     = output.environment == "production"
    error_message = "This root is always production."
  }

  assert {
    condition     = output.name_prefix == "fss-prod"
    error_message = "Production owns exactly the fss-prod namespace."
  }

  assert {
    condition     = output.destroyable == false
    error_message = "Production is never destroyable. It is a literal in main.tf, not a variable."
  }

  assert {
    condition     = output.deployment_role_name == "fss-prod-deploy"
    error_message = "Production assumes its own deployment role."
  }
}

run "no_name_production_claims_can_be_a_rehearsal_name" {
  command = plan

  assert {
    condition     = length(output.resource_names) > 25
    error_message = "The inventory must actually cover the stack; a nearly empty list proves nothing."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : strcontains(name, "fss-prod")])
    error_message = "Every name production claims must carry the production namespace."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : !strcontains(name, "fss-rh-")])
    error_message = "No name production claims may fall inside a rehearsal namespace."
  }

}

run "the_recovery_posture_is_not_a_deployment_time_choice" {
  command = plan

  assert {
    condition     = module.stack.destroyable == false
    error_message = "Deletion protection stays on across the production stack."
  }

  assert {
    condition     = module.stack.journal_object_lock.retention_days >= 3650
    error_message = "The production suppression journal keeps its objects locked for years."
  }
}

run "the_api_task_never_learns_a_secret_by_environment_value" {
  command = plan

  assert {
    condition = length([
      for name, value in module.stack.api_environment : name
      if can(regex("(?i)(password|secret|token|credential|private_key)", name))
    ]) == 0
    error_message = "Secrets reach the container only as a Secrets Manager reference."
  }

  assert {
    condition     = module.stack.api_environment["FSS_ENVIRONMENT"] == "production"
    error_message = "The container is told which environment it is in."
  }
}

# The mirror of the rehearsal acceptance case.
run "a_rehearsal_prefix_is_refused" {
  command = plan

  variables {
    name_prefix = "fss-rh-sneaky"
  }

  expect_failures = [var.name_prefix]
}

run "a_rehearsal_deployment_role_is_refused" {
  command = plan

  variables {
    deployment_role_name = "fss-rh-deploy"
  }

  expect_failures = [var.deployment_role_name]
}

run "gmail_push_wires_the_audience_the_webhook_must_require" {
  command = plan

  variables {
    enable_gmail_push = true
    gcp_project_id    = "fss-prod-example"
  }

  assert {
    condition     = output.gmail_push_audience == "https://api.example.invalid/integrations/gmail/push"
    error_message = "The audience the API must require is derived from the API hostname and published as an output."
  }

  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_AUDIENCE"] == output.gmail_push_audience
    error_message = "The container must be told the same audience the subscription mints tokens for."
  }

  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] != ""
    error_message = "The container must be told which service-account email to accept."
  }
}

run "gmail_push_cannot_be_turned_on_without_a_project" {
  command = plan

  variables {
    enable_gmail_push = true
    gcp_project_id    = ""
  }

  expect_failures = [var.gcp_project_id]
}

run "only_the_load_balancer_faces_the_internet" {
  command = plan

  assert {
    condition = alltrue([
      for name, rule in module.stack.ingress_rules :
      rule.group == "alb" && rule.from_port == 443
      if rule.cidr_ipv4 == "0.0.0.0/0" || rule.cidr_ipv6 == "::/0"
    ])
    error_message = "In production as in the module, ALB 443 is the only open-world ingress."
  }

  assert {
    condition     = length([for name, rule in module.stack.ingress_rules : name if rule.group == "worker_task"]) == 0
    error_message = "The production worker admits nothing inbound."
  }
}
