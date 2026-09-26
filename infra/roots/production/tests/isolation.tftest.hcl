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

# No `mock_provider "google"`, because there is no Google provider to mock. That
# absence is the fix for audit O01: while this root required the provider, every
# production plan needed a Google login. The push objects and their offline test
# are `infra/roots/production-google`'s now.
# `docs/archive/decisions/g85-the-google-provider-has-its-own-root.md`.

variables {
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
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

  # Wave 2: the desktop update channel is production's alone.
  assert {
    condition     = length([for name in output.resource_names : name if startswith(name, "fss-prod-updates-")]) == 1
    error_message = "Production builds the update channel's package bucket, and its distribution with it."
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

# David's topology answers of 20 September 2026 (docs/archive/decisions/coord-topology-answers.md),
# asserted against the plan rather than against the variables they were passed.
#
# They were written into `terraform.tfvars`, which `infra/.gitignore` ignores, so the
# answers never reached the repository and both roots still planned X86_64 against
# `linux/arm64` images. Tfvars stay ignored; the answers are the defaults, and this run
# is what makes them a fact somebody would have to edit a test to change. See
# docs/archive/decisions/g12c-the-topology-answers-are-root-defaults.md.
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

  # The two one-off task definitions exist in production too, so the rehearsal is a
  # copy of this rather than of something else.
  assert {
    condition     = join(",", module.stack.one_off_task_families) == "fss-prod-migration,fss-prod-operations"
    error_message = "Production carries the same two one-off task definitions the rehearsal runs."
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
    condition = (module.stack.deployment_plan.api.planned_desired_count == 0
    && module.stack.deployment_plan.worker.planned_desired_count == 0)
    error_message = "The first apply of a fresh production environment creates both services at desired count zero."
  }

  assert {
    condition = (module.stack.deployment_plan.api.declared_desired_count == 2
    && module.stack.deployment_plan.worker.declared_desired_count == 1)
    error_message = "The declared counts survive the bootstrap; they are what release-deploy.sh scales to."
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

# Lane g81, audit S17: with the secrets production really creates, each task
# definition carries what its process reads. The API's authentication material —
# the session-signing key, the device-credential pepper and the sign-in client —
# reaches the API alone.
run "each_production_task_carries_only_the_secrets_its_process_reads" {
  command = plan

  assert {
    condition = (
      module.stack.task_secret_names.api == tolist(["DATABASE_SECRET_ARN", "device-credential-pepper", "google-gmail-oauth-client", "google-oidc-client", "session-signing-key"])
      && module.stack.task_secret_names.worker == tolist(["DATABASE_SECRET_ARN", "FSS_LLM_CLASSIFIER_API_KEY", "google-gmail-oauth-client"])
      && module.stack.task_secret_names.operations == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client"])
    )
    error_message = "Every production task definition carries the secrets its own process reads: the authentication secrets reach the API alone, and the classifier key reaches the worker as FSS_LLM_CLASSIFIER_API_KEY."
  }
}

# The three deployment flags both binaries refuse to start without, or refuse to
# guess at. See docs/archive/decisions/g12c-the-deployment-flags-are-root-variables.md.
run "the_deployment_flags_reach_both_containers" {
  command = plan

  assert {
    condition = (module.stack.api_environment["FSS_DEPENDENCIES"] == "live"
    && module.stack.worker_environment["FSS_DEPENDENCIES"] == "live")
    error_message = "A production deployment runs on live dependencies; an unset switch is a refusal to start, so the apply has to set it."
  }

  # Committed, not a variable (26 September 2026): the release gate has passed and David
  # enabled sending, so a plan that forgets a `-var` can no longer turn it off.
  assert {
    condition = (module.stack.api_environment["FSS_SENDING_ENABLED"] == "true"
    && module.stack.worker_environment["FSS_SENDING_ENABLED"] == "true")
    error_message = "16.2: production's deployment flag is committed true in infra/roots/production; turning it off is a change to that literal."
  }
}

run "gmail_push_wires_the_audience_the_webhook_must_require" {
  command = plan

  assert {
    condition     = output.gmail_push_audience == "https://api.usecallie.com/integrations/gmail/push"
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

  # The topic `users.watch` names and the one identity the webhook accepts.
  # Since lane g85 they are public identifiers of objects
  # `infra/roots/production-google` owns, carried here as committed defaults,
  # so a plan knows them without asking Google, and the literals below are the
  # production ones rather than a mock's. These assertions are what proves the
  # hop from the two variables into both task definitions.
  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"] == "projects/callie-fss/topics/fss-prod-gmail-push"
    error_message = "The API must be told the production topic the watch registers against."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_GMAIL_PUSH_TOPIC"] == output.gmail_push_topic_id
    error_message = "The worker renews the Gmail watch and must be told the same topic the root publishes."
  }

  assert {
    condition     = module.stack.api_environment["FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] == "fss-prod-gmail-push@callie-fss.iam.gserviceaccount.com"
    error_message = "The webhook accepts exactly one service account, and it is the production push identity."
  }

  assert {
    condition     = module.stack.worker_environment["FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] == output.gmail_push_service_account
    error_message = "Both processes are told the same push identity the root publishes."
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
# in `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
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

# The restore runbook's one Terraform input (docs/greenfield/runbooks/restore.md).
# FSS_DATABASE_HOST is the host every process connects to in place of the one inside
# its database secret, and `task_network_configuration.database_host` is what the
# release scripts compare a registered definition's FSS_DATABASE_HOST with, so the
# two must name the same host whatever the input says.
#
# The instance's address is computed, and the mock provider fills computed values
# only during an apply, so this plan gives the managed instance an address of its
# own; without it the three values below would be unknown and the run could not
# tell the managed instance from anything else.
run "every_task_connects_to_the_managed_instance_by_default" {
  command = plan

  override_resource {
    target          = module.stack.module.database.aws_db_instance.main
    override_during = plan
    values = {
      address = "fss-prod-pg.mock.us-east-1.rds.amazonaws.com"
    }
  }

  assert {
    condition = (module.stack.api_environment["FSS_DATABASE_HOST"] == "fss-prod-pg.mock.us-east-1.rds.amazonaws.com"
      && module.stack.worker_environment["FSS_DATABASE_HOST"] == "fss-prod-pg.mock.us-east-1.rds.amazonaws.com"
    && module.stack.task_network_configuration.database_host == "fss-prod-pg.mock.us-east-1.rds.amazonaws.com")
    error_message = "With active_database_host unset, the services and the release scripts all name the managed instance's address."
  }
}

run "a_restored_copy_s_address_reaches_every_task_and_the_release_scripts" {
  command = plan

  variables {
    active_database_host = "fss-prod-pg-r20261001.example.us-east-1.rds.amazonaws.com"
  }

  assert {
    condition = (module.stack.api_environment["FSS_DATABASE_HOST"] == "fss-prod-pg-r20261001.example.us-east-1.rds.amazonaws.com"
      && module.stack.worker_environment["FSS_DATABASE_HOST"] == "fss-prod-pg-r20261001.example.us-east-1.rds.amazonaws.com"
    && module.stack.task_network_configuration.database_host == "fss-prod-pg-r20261001.example.us-east-1.rds.amazonaws.com")
    error_message = "active_database_host is FSS_DATABASE_HOST on the API and the worker (and so on the operations tool), and the host the release scripts expect a registered definition to carry."
  }
}

run "an_active_database_host_with_a_scheme_is_refused" {
  command = plan

  variables {
    active_database_host = "https://x"
  }

  expect_failures = [var.active_database_host]
}

run "an_active_database_host_with_a_port_is_refused" {
  command = plan

  variables {
    active_database_host = "host:5432"
  }

  expect_failures = [var.active_database_host]
}

run "an_active_database_host_in_upper_case_is_refused" {
  command = plan

  variables {
    active_database_host = "UPPER.example.com"
  }

  expect_failures = [var.active_database_host]
}

run "an_active_database_host_with_no_dot_is_refused" {
  command = plan

  variables {
    active_database_host = "nodot"
  }

  expect_failures = [var.active_database_host]
}

# Lane g86. `/auth/client-version` publishes the signed update manifest in
# production, on the API task alone, and the root refuses the placeholder the
# API falls back to elsewhere.
# `docs/archive/decisions/g86-the-upgrade-notice-names-the-update-channel.md`.
run "the_production_api_names_the_update_manifest_as_its_upgrade_address" {
  command = plan

  assert {
    condition     = module.stack.api_environment["FSS_DESKTOP_UPGRADE_URL"] == "https://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json"
    error_message = "The production API publishes the signed update manifest, releases/darwin-arm64/latest.json on the updates distribution."
  }

  assert {
    condition     = !contains(keys(module.stack.worker_environment), "FSS_DESKTOP_UPGRADE_URL")
    error_message = "The upgrade address is the API's alone."
  }
}

run "a_production_upgrade_address_that_is_the_placeholder_is_refused" {
  command = plan

  variables {
    desktop_upgrade_url = "https://callie.example/downloads/mac"
  }

  expect_failures = [var.desktop_upgrade_url]
}

run "a_production_upgrade_address_that_is_not_plain_https_is_refused" {
  command = plan

  variables {
    desktop_upgrade_url = "http://dlcmdaeskewt5.cloudfront.net/releases/darwin-arm64/latest.json"
  }

  expect_failures = [var.desktop_upgrade_url]
}
