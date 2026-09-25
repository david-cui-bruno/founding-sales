# Structural isolation of the production root from every rehearsal run, and
# the production postures that are not deployment-time choices.
#
# Offline only: every run is a mocked plan, there is no backend and there are
# no credentials. The account id and every ARN below are the AWS documentation
# example values, never real ones.

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

# The Google mock keeps `plan`, deliberately, and it is the only one in `infra`
# that does. The runs below assert that the topic id and the push identity this
# root creates reach both task definitions, and those are values a real plan
# does not know: with `override_during = apply` the assertions could not be
# evaluated at all. The `count` on `module.pubsub` keys off a plain variable, so
# the unknown-at-plan class this file otherwise guards against cannot hide here.
# `docs/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
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

# g42, lane g55. Production's metrics, metric filters and alarms live in
# FSS/fss-prod. A rehearsal publishes into FSS/fss-rh-<run>, and its task roles
# may publish nowhere else, so nothing a rehearsal does can trip or mask one of
# these alarms, and nothing reading FSS/fss-prod reads a rehearsal's datapoint.
run "production_publishes_and_alarms_in_its_own_metric_namespace" {
  command = plan

  assert {
    condition     = output.metric_namespace == "FSS/fss-prod"
    error_message = "Production's metric namespace is exactly FSS/fss-prod."
  }

  assert {
    condition = (module.stack.api_environment["FSS_METRIC_NAMESPACE"] == "FSS/fss-prod"
    && module.stack.worker_environment["FSS_METRIC_NAMESPACE"] == "FSS/fss-prod")
    error_message = "Both production services are told to publish into FSS/fss-prod."
  }

  assert {
    condition     = module.stack.alarm_metric_namespaces == tolist(["FSS/fss-prod"])
    error_message = "Every production alarm reads FSS/fss-prod and no other namespace."
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
# G12h. Production is bootstrapped once, ever, and every apply after that runs the
# services. So the default is `false` here and `true` in the rehearsal root, and the
# flag is a value an operator passes rather than a state nobody can see.
run "production_runs_its_services_unless_an_operator_says_this_is_a_bootstrap" {
  command = plan

  assert {
    condition     = module.stack.deployment_plan.bootstrap == false
    error_message = "An ordinary production apply is not a bootstrap; true creates both services at zero, which is only ever right for a brand-new environment."
  }

  assert {
    condition = (module.stack.deployment_plan.api.planned_desired_count == module.stack.deployment_plan.api.declared_desired_count
    && module.stack.deployment_plan.worker.planned_desired_count == module.stack.deployment_plan.worker.declared_desired_count)
    error_message = "Outside a bootstrap a service is created at its declared count. After that the count is the release scripts' (ignore_changes, lane g70)."
  }

  # The three one-off task definitions exist in production too, so the rehearsal is a
  # copy of this rather than of something else. `fss drill` is never launched by a
  # production release; it is here because the two environments must be the same
  # shape, which is what makes rehearsing worth anything.
  assert {
    condition     = join(",", module.stack.one_off_task_families) == "fss-prod-migration,fss-prod-operations,fss-prod-drill"
    error_message = "Production carries the same three one-off task definitions the rehearsal drills against."
  }

  assert {
    condition = (module.stack.task_network_configuration.assign_public_ip == "ENABLED"
    && module.stack.task_network_configuration.inbound_rule_count == 0)
    error_message = "A one-off task needs a public address because there is no NAT gateway, and that is only safe because the worker security group admits nothing inbound."
  }
}

run "a_production_bootstrap_creates_both_services_at_zero" {
  command = plan

  variables {
    bootstrap = true
  }

  # A fresh production database has no schema and both binaries refuse to start
  # unless the applied version is exactly the range they declare. The migration task
  # cannot be launched until the cluster exists, so the only order that works is:
  # create at zero, migrate, verify, scale.
  assert {
    condition = (module.stack.service_shape.api.desired_count == 0
    && module.stack.service_shape.worker.desired_count == 0)
    error_message = "The first apply of a fresh production environment creates both services at desired count zero."
  }

  assert {
    condition = (module.stack.deployment_plan.api.declared_desired_count == 2
    && module.stack.deployment_plan.worker.declared_desired_count == 1)
    error_message = "The declared counts survive the bootstrap; they are what release-deploy.sh scales to."
  }
}

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

# Lane g81, audit S17: with the secrets production really creates, each task
# definition carries what its process reads. The API's authentication material —
# the session-signing key, the device-credential pepper and the sign-in client —
# reaches the API alone.
run "each_production_task_carries_only_the_secrets_its_process_reads" {
  command = plan

  assert {
    condition = (
      module.stack.task_secret_names.api == tolist(["DATABASE_SECRET_ARN", "device-credential-pepper", "google-gmail-oauth-client", "google-oidc-client", "session-signing-key"])
      && module.stack.task_secret_names.worker == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client", "llm-classifier-api-key", "research-provider-credentials"])
      && module.stack.task_secret_names.operations == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client"])
      && module.stack.task_secret_names.drill == tolist(["DATABASE_SECRET_ARN", "MIGRATION_DATABASE_SECRET", "google-gmail-oauth-client"])
    )
    error_message = "Every production task definition carries the secrets its own process reads, and the authentication secrets reach the API alone."
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

  # All three, non-empty, in both task definitions. Each is read with
  # `required()` by both bootstraps, so an empty one is a service that refuses
  # to start; this is the same assertion the rehearsal root makes about its own
  # three values.
  assert {
    condition = alltrue([
      for name in ["FSS_GMAIL_PUSH_AUDIENCE", "FSS_GMAIL_PUSH_TOPIC", "FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] :
      length(module.stack.api_environment[name]) > 0 && length(module.stack.worker_environment[name]) > 0
    ])
    error_message = "Both binaries read all three push identifiers with required(); an empty value is a task that exits at start-up."
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
  #
  # G12j moved `module.pubsub` from the stack into this root, so the string
  # makes one hop it did not make before: out of the module, into
  # `module.stack`'s `gmail_push_topic`, and into both task definitions. These
  # two assertions are what proves the hop.
  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"] == output.gmail_push_topic_id
    error_message = "The API must be told the topic the watch registers against."
  }

  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] == output.gmail_push_service_account
    error_message = "The webhook accepts exactly one service account, and it is the one the subscription mints tokens for."
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

# G12e: the provider assumes the deployment role only when the session is not
# already that role.
#
# `assume_deployment_role` chooses a *credential path*, and a mocked plan cannot
# observe one: `mock_provider "aws"` replaces the provider configuration
# entirely, so no `assume_role` block, no STS call and no credential chain is
# exercised by anything below. What these two runs prove is the part a plan can
# see — the variable exists, production defaults to assuming the role (so a
# forgotten flag is refused at STS rather than acting as whatever ambient
# credential the shell was holding), and turning it off changes nothing about
# what the root creates. That the provider really skips the assumption when the
# block is absent is a property of the AWS provider, taken from its own schema
# in `docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
run "production_assumes_its_deployment_role_by_default" {
  command = plan

  assert {
    condition     = var.assume_deployment_role
    error_message = "The default is true in every root: section 3.2's local apply is David's user assuming fss-prod-deploy, and a forgotten flag must fail loudly rather than act as an ambient credential."
  }

  assert {
    condition     = output.deployment_role_name == "fss-prod-deploy"
    error_message = "The role the provider assumes is production's, and the flag does not change which one it is."
  }
}

run "the_assume_flag_chooses_a_credential_path_and_not_a_plan" {
  command = plan

  variables {
    assume_deployment_role = false
  }

  assert {
    condition     = output.name_prefix == "fss-prod" && output.deployment_role_name == "fss-prod-deploy"
    error_message = "Nothing this root creates may depend on how the caller obtained its credentials."
  }

  assert {
    condition     = length(output.resource_names) > 0
    error_message = "The root still plans with the assumption turned off; otherwise the flag would be a way to plan an empty stack."
  }
}

# Lane g56. Production is unpinned in code: the value is read from the database
# with an operations task and set by an operator (docs/greenfield/release.md, "The
# expected system generation"). A default here would be a generation nobody read.
run "production_is_unpinned_in_code" {
  command = plan

  assert {
    condition = (!contains(keys(module.stack.api_environment), "FSS_EXPECTED_SYSTEM_GENERATION")
    && !contains(keys(module.stack.worker_environment), "FSS_EXPECTED_SYSTEM_GENERATION"))
    error_message = "No production generation is pinned in code."
  }
}

run "an_operator_pin_reaches_both_production_services" {
  command = plan

  variables {
    expected_system_generation = 2
  }

  assert {
    condition = (module.stack.api_environment["FSS_EXPECTED_SYSTEM_GENERATION"] == "2"
    && module.stack.worker_environment["FSS_EXPECTED_SYSTEM_GENERATION"] == "2")
    error_message = "Appendix E step 1's control must reach the worker, which opens the restore holds, and the API, which reports the mismatch."
  }
}

run "a_production_generation_that_is_not_a_positive_whole_number_is_refused" {
  command = plan

  variables {
    expected_system_generation = 0
  }

  expect_failures = [var.expected_system_generation]
}
