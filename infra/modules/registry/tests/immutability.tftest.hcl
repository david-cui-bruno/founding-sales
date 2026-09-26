mock_provider "aws" {
  override_during = apply
}

variables {
  name_prefix = "fss-test"
}

run "repositories_are_immutable_scanned_and_keep_their_images" {
  command = plan

  assert {
    condition = alltrue([
      for repository in aws_ecr_repository.this :
      repository.image_tag_mutability == "IMMUTABLE" && repository.image_scanning_configuration[0].scan_on_push && repository.force_delete == false
    ])
    error_message = "Tags are immutable (a digest that passed the gate cannot be re-tagged to other bytes), every push is scanned, and a repository holding images refuses deletion."
  }
}
