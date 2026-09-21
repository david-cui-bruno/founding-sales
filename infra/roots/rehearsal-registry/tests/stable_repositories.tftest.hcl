# The two stable rehearsal repositories exist, are named what the release
# workflow's secrets say, and cannot be named anything else.
#
# Offline only: a mocked plan, no backend, no credentials. Every identifier
# below is an AWS documentation example value.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:123456789012:repository/mock"
      registry_id    = "123456789012"
      repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/mock"
    }
  }
}

variables {
  aws_account_id = "123456789012"
}

run "the_two_repositories_are_the_ones_the_workflow_secrets_name" {
  command = plan

  assert {
    condition     = module.registry.repository_names["api"] == "fss-rh-api"
    error_message = "FSS_REHEARSAL_API_REPOSITORY ends in /fss-rh-api and nothing else produces that name."
  }

  assert {
    condition     = module.registry.repository_names["worker"] == "fss-rh-worker"
    error_message = "FSS_REHEARSAL_WORKER_REPOSITORY ends in /fss-rh-worker."
  }

  assert {
    condition     = length(output.resource_names) == 2
    error_message = "This root claims exactly two names. Anything else belongs to a run or to production."
  }

  # The whole point of a separate root: the names carry no run.
  assert {
    condition = alltrue([
      for name in output.resource_names : startswith(name, "fss-rh-") && !can(regex("^fss-rh-[0-9]", name))
    ])
    error_message = "The stable repositories are in the rehearsal namespace and carry no run identifier."
  }

  assert {
    condition     = alltrue([for name in output.resource_names : !strcontains(name, "fss-prod")])
    error_message = "Nothing this root claims may fall inside the production namespace."
  }
}

run "the_repositories_keep_the_settings_production_s_registry_has" {
  command = plan

  assert {
    condition = alltrue([
      for settings in values(module.registry.repository_settings) : settings.image_tag_mutability == "IMMUTABLE"
    ])
    error_message = "Tags are immutable: a digest that passed the rehearsal gate cannot later point at different bytes."
  }

  assert {
    condition = alltrue([
      for settings in values(module.registry.repository_settings) : settings.scan_on_push
    ])
    error_message = "Scan on push, as in production."
  }

  # Not production's value for its own sake: production is not destroyable and
  # so passes false too. These repositories hold the images every past release
  # was rehearsed on, and a destroy that emptied them silently would be worse
  # than one that failed.
  assert {
    condition = alltrue([
      for settings in values(module.registry.repository_settings) : settings.force_delete == false
    ])
    error_message = "A repository that still holds images refuses to be deleted."
  }
}

run "a_production_deployment_role_is_refused" {
  command = plan

  variables {
    deployment_role_name = "fss-prod-deploy"
  }

  expect_failures = [var.deployment_role_name]
}

# G12e: this root's only apply is a workflow run whose session is already
# `fss-rh-deploy`, so `.github/workflows/greenfield-rehearsal-registry.yml`
# plans with `assume_deployment_role=false` — the provider must not ask STS to
# assume the role the session already holds, because that role trusts the OIDC
# provider and nothing else, least of all itself.
#
# The default stays true so that the flag is something a caller says out loud.
# A mocked plan cannot see a credential chain; these runs prove the variable
# exists, its default, and that the two repositories are the same either way.
run "the_registry_root_assumes_its_deployment_role_by_default" {
  command = plan

  assert {
    condition     = var.assume_deployment_role
    error_message = "The default is true in all three roots, so a forgotten flag fails at STS rather than acting as an ambient credential."
  }
}

run "the_assume_flag_chooses_a_credential_path_and_not_a_plan" {
  command = plan

  variables {
    assume_deployment_role = false
  }

  assert {
    condition     = length(output.resource_names) == 2
    error_message = "This root claims exactly two names however the caller obtained its credentials."
  }

  assert {
    condition     = module.registry.repository_names["api"] == "fss-rh-api" && module.registry.repository_names["worker"] == "fss-rh-worker"
    error_message = "The names the workflow secrets point at do not depend on the credential path."
  }
}
