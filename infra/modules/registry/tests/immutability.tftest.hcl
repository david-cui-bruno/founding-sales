mock_provider "aws" {
  override_during = plan
}

variables {
  name_prefix = "fss-test"
}

run "repositories_are_immutable_and_scanned" {
  command = plan

  assert {
    condition     = length(aws_ecr_repository.this) == 2
    error_message = "One repository per deployable service: api and worker."
  }

  assert {
    condition     = alltrue([for repository in aws_ecr_repository.this : repository.image_tag_mutability == "IMMUTABLE"])
    error_message = "A digest that passed the rehearsal gate must not be re-tagged to different bytes."
  }

  assert {
    condition     = alltrue([for repository in aws_ecr_repository.this : repository.image_scanning_configuration[0].scan_on_push])
    error_message = "Every push must be scanned."
  }

  assert {
    condition     = alltrue([for repository in aws_ecr_repository.this : repository.force_delete == false])
    error_message = "The default posture keeps images; only a destroyable rehearsal root may force delete."
  }

  assert {
    condition     = alltrue([for name, repository in aws_ecr_repository.this : startswith(repository.name, "fss-test-")])
    error_message = "Repository names carry the environment namespace."
  }
}
