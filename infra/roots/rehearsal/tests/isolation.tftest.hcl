# Structural isolation of the rehearsal root from production.
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
# absence is the fix: the third credentialed rehearsal's plan was refused Google
# application-default credentials before it made a single AWS call, and a mocked
# provider in a test can never catch that — `mock_provider` replaces the
# configuration the real plan would have had to make.
# `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.

variables {
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
    condition = (
      output.environment == "rehearsal"
      && output.destroyable == true
      && startswith(output.name_prefix, "fss-rh-")
      && startswith(output.deployment_role_name, "fss-rh-")
      && output.journal_object_lock.mode == "GOVERNANCE"
      && output.journal_object_lock.retention_days == 1
    )
    error_message = "A rehearsal run lives in the fss-rh- namespace with its own deployment role, must be able to disappear, and keeps object lock honest but short enough that its journal bucket can be removed."
  }
}

run "no_name_this_run_claims_can_be_a_production_name" {
  command = plan

  assert {
    condition = (
      length(output.resource_names) > 25
      && alltrue([for name in output.resource_names : strcontains(name, output.name_prefix) && !strcontains(name, "fss-prod")])
    )
    error_message = "Every name this run claims carries the run namespace and none falls inside production's. The count is asserted too: a nearly empty inventory would pass the alltrue over nothing."
  }

  # Wave 2: a rehearsal publishes no Electron package, so it builds no update
  # channel: no package bucket and no CloudFront distribution.
  assert {
    condition = (
      length([for name in output.resource_names : name if strcontains(name, "-updates-")]) == 0
      && module.stack.updates_distribution_domain_name == null
    )
    error_message = "A rehearsal builds neither the updates bucket nor its CloudFront distribution."
  }
}

# The per-run root creates no ECR repository.
#
# It used to create `fss-rh-<run>-api` and `fss-rh-<run>-worker`, which cannot work:
# the images have to be pushed *before* the run exists, the release workflow's
# environment secrets name the stable `fss-rh-api` and `fss-rh-worker`, and a
# repository created by a run is destroyed with it. `infra/roots/rehearsal-registry`
# owns the two stable repositories and is applied once. See
# docs/archive/decisions/g12c-the-rehearsal-registry-is-its-own-root.md.
run "the_run_creates_no_repository_of_its_own" {
  command = plan

  assert {
    condition = (
      length(keys(module.stack.repository_urls)) == 0
      && length([for name in output.resource_names : name if strcontains(name, "ecr")]) == 0
    )
    error_message = "A rehearsal run deploys from the stable rehearsal repositories; it does not create its own, claim their names, and take them away again."
  }
}

run "a_run_may_only_deploy_from_the_stable_rehearsal_repositories" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  }

  # The digest is the one proposed for production; the repository it is pulled
  # from is not. `fss-rh-deploy` has no permission to read a production
  # repository, so this would fail as an ECR authorization error minutes into a
  # deployment. It fails at plan time instead, naming the variable.
  expect_failures = [var.api_image]
}

run "a_second_run_shares_no_name_with_the_first" {
  command = plan

  variables {
    name_prefix = "fss-rh-second"
  }

  assert {
    condition = (
      alltrue([for name in output.resource_names : strcontains(name, "fss-rh-second") && !strcontains(name, "fss-rh-default-")])
      && output.metric_namespace == "FSS/fss-rh-second"
    )
    error_message = "A second concurrent rehearsal run claims its own namespace, collides with nothing of the first run's, and publishes and alarms in its own metric namespace."
  }
}

# g42, lane g55. The tenth full run's smoke read production's canary age, because
# every environment in the account published into the bare FSS namespace and every
# alarm read it. The namespace is now FSS/<prefix>, derived in the stack, and this
# run proves it reaches both ends: what the tasks are told to publish into and what
# every alarm reads. The rehearsal smoke reads `output.metric_namespace`.
run "the_run_publishes_and_alarms_in_its_own_metric_namespace" {
  command = plan

  assert {
    condition = (
      output.metric_namespace == "FSS/${output.name_prefix}"
      && output.metric_namespace != "FSS"
      && !strcontains(output.metric_namespace, "fss-prod")
      && module.stack.api_environment["FSS_METRIC_NAMESPACE"] == output.metric_namespace
      && module.stack.worker_environment["FSS_METRIC_NAMESPACE"] == output.metric_namespace
      && module.stack.alarm_metric_namespaces == tolist([output.metric_namespace])
    )
    error_message = "The run publishes from both services into FSS/<its prefix>, never the bare namespace or production's, and every alarm it creates reads that namespace and no other."
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

# One API task and one worker; sizes and architecture are production's (the cluster
# module holds them).
run "the_topology_answers_are_the_rehearsal_defaults_at_one_plus_one" {
  command = plan

  # One of each — eventually. Every rehearsal environment is a fresh one, so the
  # root's `bootstrap` default is `true` and the apply creates both services at zero
  # (G12h): the database has no schema yet and both binaries refuse to start unless
  # the applied version is exactly the range they declare.
  # `infra/scripts/release-deploy.sh` scales them to the declared counts after the
  # migration task and `fss verify` succeed, and it reads those counts from
  # `deployment_plan` rather than from a literal — which is why both numbers are
  # asserted here rather than only the one the plan happens to show.
  assert {
    condition = (
      module.stack.deployment_plan.bootstrap
      && module.stack.deployment_plan.api.planned_desired_count == 0
      && module.stack.deployment_plan.worker.planned_desired_count == 0
      && module.stack.deployment_plan.api.declared_desired_count == 1
      && module.stack.deployment_plan.worker.declared_desired_count == 1
    )
    error_message = "A rehearsal apply creates both services at zero — nothing can start before the migration task has run — and the declared counts are one of each: the shapes are production's, the counts are not, and these are the numbers the deploy script scales to."
  }
}

# The same root with the bootstrap off. Without this run the assertions above would be
# satisfied by a root that could only ever create services at zero. It is a plan with
# no state, so it shows the count a service is *created* at: since lane g70 both
# services carry `ignore_changes = [desired_count]`, and a re-apply of a standing
# environment leaves the running count to `release-stop.sh` and `release-deploy.sh`
# (`infra/modules/cluster/tests/release_owns_the_count.tftest.hcl` applies that;
# `docs/archive/decisions/g12h-bootstrap-is-a-root-variable.md`, "Amended").
run "a_rehearsal_re_apply_declares_the_real_counts" {
  command = plan

  variables {
    bootstrap = false
  }

  assert {
    condition = (
      module.stack.deployment_plan.bootstrap == false
      && module.stack.deployment_plan.api.planned_desired_count == 1
      && module.stack.deployment_plan.worker.planned_desired_count == 1
    )
    error_message = "With the bootstrap off the plan says so, and Terraform creates the services at the counts they are declared to run at."
  }
}

# The rehearsal's own deployment flags. `live` here, not `recorded`: G12b made
# sign-in a start-up requirement and the rehearsal signs in with the real Google
# OIDC client under its second registered redirect URI
# (api.rehearsal.usecallie.com). The one step that wants the recorded Gmail fake
# sets FSS_DEPENDENCIES in the workflow step rather than in the apply.
run "the_rehearsal_deploys_on_live_dependencies_with_sending_off" {
  command = plan

  assert {
    condition = (
      module.stack.api_environment["FSS_DEPENDENCIES"] == "live"
      && module.stack.worker_environment["FSS_DEPENDENCIES"] == "live"
      && module.stack.api_environment["FSS_SENDING_ENABLED"] == "false"
      && module.stack.worker_environment["FSS_SENDING_ENABLED"] == "false"
    )
    error_message = "The rehearsal signs in against the rehearsal hostname with the real client, so its deployment is live, and it never sends: nothing in the workflow sets the flag true and the default is the refusal."
  }

  # Lane g81. Live dependencies, and still no classifier: the rehearsal fills the
  # classifier entry with a fixture and the classifier has no recorded seam, so a
  # rehearsal worker holding the key would send fixture replies to the provider.
  assert {
    condition     = module.stack.task_secret_names.worker == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client"])
    error_message = "A rehearsal worker is handed the Gmail client and its database entry, and never the classifier key."
  }
}

run "both_services_are_told_the_workspace_domain" {
  command = plan

  # The same Workspace, because the rehearsal signs in with the same Google OIDC
  # client (its second registered redirect URI). The environment carries it rather
  # than a field inside an operator-pasted secret.
  assert {
    condition = (
      module.stack.api_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
      && module.stack.worker_environment["FSS_GOOGLE_HOSTED_DOMAIN"] == "usecallie.com"
    )
    error_message = "Both rehearsal processes restrict sign-in to the Callie Workspace domain."
  }
}

# The rehearsal has no Google Cloud project, and its tasks still have to start.
#
# Both bootstraps call `required()` on all three push names, so an empty one is
# `FSS_GMAIL_PUSH_AUDIENCE is not set` and a task that exits rather than a task
# with push switched off. Until this lane the rehearsal passed three empty
# strings, which no offline layer objected to and no rehearsal had yet run far
# enough to discover.
run "the_rehearsal_tasks_are_told_a_push_audience_they_can_start_with" {
  command = plan

  assert {
    condition = alltrue([
      for name in ["FSS_GMAIL_PUSH_AUDIENCE", "FSS_GMAIL_PUSH_TOPIC", "FSS_GMAIL_PUSH_SERVICE_ACCOUNT"] :
      length(module.stack.api_environment[name]) > 0 && length(module.stack.worker_environment[name]) > 0
    ])
    error_message = "Both binaries read all three push identifiers with required(). An empty value is a task that refuses to start."
  }

  # The audience is this environment's own webhook URL, derived from its own hostname:
  # the value a locally signed rehearsal push token would have to carry, and it needs
  # no Google resource to be true. The topic is well-formed and names a project that
  # does not exist — the shape is what `users.watch` takes, and the name is why nobody
  # can read a rehearsal as evidence that Gmail push works — and no Google identity is
  # named, because Google cannot mint a token for an address in the reserved .invalid
  # domain.
  assert {
    condition = (
      module.stack.api_environment["FSS_GMAIL_PUSH_AUDIENCE"] == "https://rehearsal.example.invalid/integrations/gmail/push"
      && can(regex("^projects/[^/]+/topics/[^/]+$", module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"]))
      && strcontains(module.stack.api_environment["FSS_GMAIL_PUSH_TOPIC"], "no-push")
      && endswith(module.stack.worker_environment["FSS_GMAIL_PUSH_SERVICE_ACCOUNT"], ".invalid")
    )
    error_message = "The rehearsal audience is built from the rehearsal hostname and the push path, its topic is a well-formed id in a project that does not exist, and the push identity is unreachable: a rehearsal registers no Gmail watch."
  }
}

# G12e: the release workflow's session is already `fss-rh-deploy`, so the
# provider must not ask STS to assume it a second time.
#
# The default is true here as it is in production, even though every apply of
# this root is a workflow run: a default of false would mean a root that acts as
# whatever credential is lying around whenever somebody forgets the flag, and a
# root whose refusal — `sts:AssumeRole` on a role that trusts only the OIDC
# subject — is the boundary working. `.github/workflows/greenfield-release.yml`
# and `infra/scripts/rehearsal-teardown.sh` pass `assume_deployment_role=false`
# explicitly, after `infra/scripts/rehearsal-caller-identity.sh` has proved the
# session really is `fss-rh-deploy`.
#
# A tftest cannot observe any of that: `mock_provider "aws"` replaces the
# provider configuration, so the credential chain is not exercised here even in
# principle. These runs prove the variable exists, its default, and that the
# plan is the same either way.
run "the_rehearsal_root_assumes_its_deployment_role_by_default" {
  command = plan

  assert {
    condition     = var.assume_deployment_role && output.deployment_role_name == "fss-rh-deploy"
    error_message = "A forgotten flag must be refused at STS, not run as an ambient credential; the default is true in all three roots, and the role is the rehearsal one whether or not the provider is the thing that assumes it."
  }
}

run "the_assume_flag_chooses_a_credential_path_and_not_a_plan" {
  command = plan

  variables {
    assume_deployment_role = false
  }

  assert {
    condition = (
      startswith(output.name_prefix, "fss-rh-")
      && output.deployment_role_name == "fss-rh-deploy"
      && alltrue([for name in output.resource_names : !strcontains(name, "fss-prod")])
    )
    error_message = "Nothing this root creates may depend on how the caller obtained its credentials: the namespace refusal is a property of the root, and it holds with the assumption turned off too."
  }
}

# Lane g86. The upgrade notice's address is production's: the rehearsal root has
# no variable for it, so its API publishes the placeholder a non-production API
# falls back to, and no worker is ever handed it.
run "the_rehearsal_api_is_told_no_upgrade_address" {
  command = plan

  assert {
    condition = (!contains(keys(module.stack.api_environment), "FSS_DESKTOP_UPGRADE_URL")
    && !contains(keys(module.stack.worker_environment), "FSS_DESKTOP_UPGRADE_URL"))
    error_message = "Only the production root sets FSS_DESKTOP_UPGRADE_URL, and only on the API."
  }
}
