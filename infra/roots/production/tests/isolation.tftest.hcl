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

# David's topology answers of 20 September 2026 (docs/decisions/coord-topology-answers.md),
# asserted against the plan rather than against the variables they were passed.
#
# They were written into `terraform.tfvars`, which `infra/.gitignore` ignores, so the
# answers never reached the repository and both roots still planned X86_64 against
# `linux/arm64` images. Tfvars stay ignored; the answers are the defaults, and this run
# is what makes them a fact somebody would have to edit a test to change. See
# docs/decisions/g12c-the-topology-answers-are-root-defaults.md.
run "the_topology_answers_are_the_production_defaults" {
  command = plan

  # The blocker, and the reason this run exists. `greenfield-images.yml` builds
  # `--platform linux/arm64`; a task definition asking Fargate for X86_64 pulls a
  # manifest that is not in the index and the service never stabilises.
  assert {
    condition     = module.stack.task_runtime_platform.api.cpu_architecture == "ARM64"
    error_message = "The API task definition must declare ARM64, because that is the only architecture the images are built for."
  }

  assert {
    condition     = module.stack.task_runtime_platform.worker.cpu_architecture == "ARM64"
    error_message = "The worker task definition must declare ARM64 for the same reason."
  }

  assert {
    condition = (module.stack.task_runtime_platform.api.operating_system_family == "LINUX"
    && module.stack.task_runtime_platform.worker.operating_system_family == "LINUX")
    error_message = "Both tasks are Linux."
  }

  # Answer 2: db.t4g.small, Multi-AZ, two API tasks and one worker at 0.5 vCPU / 1 GiB.
  assert {
    condition     = module.stack.database_shape.instance_class == "db.t4g.small"
    error_message = "The production database is db.t4g.small."
  }

  assert {
    condition     = module.stack.database_shape.multi_az
    error_message = "The production database is Multi-AZ. main.tf passes the literal; this asserts it reached the instance."
  }

  assert {
    condition = (module.stack.service_shape.api.cpu == "512"
      && module.stack.service_shape.api.memory == "1024"
      && module.stack.service_shape.worker.cpu == "512"
    && module.stack.service_shape.worker.memory == "1024")
    error_message = "Both tasks are 0.5 vCPU and 1 GiB."
  }

  assert {
    condition = (module.stack.service_shape.api.desired_count == 2
    && module.stack.service_shape.worker.desired_count == 1)
    error_message = "Two API tasks and one worker task."
  }

  # Answer 5: the five billed-per-metric options stay off. Enhanced Monitoring is not a
  # root input at all (the database module's monitoring_interval defaults to 0) and
  # there is no flow-log resource anywhere in infra (docs/decisions/g1-no-flow-logs.md),
  # so those two are asserted here as the absence they are.
  assert {
    condition     = module.stack.database_shape.performance_insights_enabled == false
    error_message = "Performance Insights stays off."
  }

  assert {
    condition     = module.stack.database_shape.monitoring_interval == 0
    error_message = "Enhanced Monitoring stays off; a non-zero interval would also create a monitoring role."
  }

  assert {
    condition     = module.stack.container_insights == "disabled"
    error_message = "Container Insights stays off."
  }

  assert {
    condition     = module.stack.waf_enabled == false
    error_message = "No WAFv2 web ACL."
  }
}

run "an_architecture_that_is_not_one_of_the_two_is_refused" {
  command = plan

  variables {
    cpu_architecture = "arm64"
  }

  # Lowercase is the shape an operator who knows Docker types. ECS takes the
  # uppercase enum, and the root refuses rather than letting the module three
  # levels down name a variable nobody typed.
  expect_failures = [var.cpu_architecture]
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

# The three deployment flags both binaries refuse to start without, or refuse to
# guess at. `infra/modules/stack` had `extra_environment` and neither root exposed
# it, so there was no way to set them from an apply at all: the runbook told the
# operator to put them "in `extra_environment` or the plan review" and neither
# existed. See docs/decisions/g12c-the-deployment-flags-are-root-variables.md.
run "the_deployment_flags_reach_both_containers" {
  command = plan

  assert {
    condition = (module.stack.api_environment["FSS_DEPENDENCIES"] == "live"
    && module.stack.worker_environment["FSS_DEPENDENCIES"] == "live")
    error_message = "A production deployment runs on live dependencies; an unset switch is a refusal to start, so the apply has to set it."
  }

  assert {
    condition = (module.stack.api_environment["FSS_SENDING_ENABLED"] == "false"
    && module.stack.worker_environment["FSS_SENDING_ENABLED"] == "false")
    error_message = "16.2: the deployment flag is false until the release gate has passed on these digests and David flips it."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_RESEARCH_PROVIDERS"] == "none"
    error_message = "The worker is told, by name, that this build ships no live research adapter."
  }

  # Worker only. The API has no research adapter and a variable it never reads is a
  # variable that will drift.
  assert {
    condition     = !contains(keys(module.stack.api_environment), "FSS_RESEARCH_PROVIDERS")
    error_message = "FSS_RESEARCH_PROVIDERS belongs to the worker alone."
  }
}

run "the_flags_are_settable_and_the_escape_hatch_still_exists" {
  command = plan

  variables {
    sending_enabled = true
    extra_environment = {
      FSS_SOMETHING_LATER = "value"
    }
  }

  assert {
    condition = (module.stack.api_environment["FSS_SENDING_ENABLED"] == "true"
    && module.stack.worker_environment["FSS_SENDING_ENABLED"] == "true")
    error_message = "Section 6 step 4 flips this; a variable that could not be set would make the whole run a restatement of its default."
  }

  assert {
    condition = (module.stack.api_environment["FSS_SOMETHING_LATER"] == "value"
    && module.stack.worker_environment["FSS_SOMETHING_LATER"] == "value")
    error_message = "extra_environment exists on the stack module and must be reachable from the root."
  }
}

run "a_production_apply_cannot_ask_for_no_dependencies_at_all" {
  command = plan

  variables {
    dependencies_mode = "none"
  }

  # `none` is a real value the bootstraps accept on a laptop. It must not be
  # typeable into a root that deploys to AWS: both binaries refuse it when
  # FSS_ENVIRONMENT is production, and a plan is a better place to learn that
  # than a crash loop.
  expect_failures = [var.dependencies_mode]
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

  # The topic `users.watch` names. It was only a Terraform output, so the
  # bootstraps had to read it out of the operator-written client secret
  # (docs/decisions/g12-the-credentialed-bootstrap.md). It travels in the task
  # environment now, to both services: the worker renews the watch and the API
  # reports the configured topic.
  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"] == output.gmail_push_topic_id
    error_message = "The API must be told the topic the watch registers against."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_GMAIL_PUSH_TOPIC"] == output.gmail_push_topic_id
    error_message = "The worker renews the Gmail watch and must be told the same topic."
  }
}

run "both_services_are_told_the_workspace_domain" {
  command = plan

  # 5.1: an id token whose `hd` differs is refused, and 12.1 lets only a mailbox
  # in this domain connect. A public identifier, so it is a root variable rather
  # than a field inside a secret.
  assert {
    condition     = module.stack.api_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
    error_message = "The API restricts sign-in and mailbox connection to the Callie Workspace domain."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
    error_message = "The worker reads the same domain, so the two processes cannot disagree about it."
  }
}

run "an_empty_hosted_domain_is_refused" {
  command = plan

  variables {
    google_hosted_domain = ""
  }

  expect_failures = [var.google_hosted_domain]
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
