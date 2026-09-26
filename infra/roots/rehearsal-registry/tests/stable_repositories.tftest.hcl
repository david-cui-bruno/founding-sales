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

run "the_two_repositories_are_the_ones_the_workflow_secrets_name" {
  command = plan

  assert {
    condition     = output.repository_names == { api = "fss-rh-api", worker = "fss-rh-worker" }
    error_message = "FSS_REHEARSAL_API_REPOSITORY and FSS_REHEARSAL_WORKER_REPOSITORY end in /fss-rh-api and /fss-rh-worker, and this root claims nothing else."
  }
}
