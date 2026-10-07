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

run "only_unreferenced_untagged_images_expire" {
  command = plan
  assert {
    condition = alltrue([for policy in aws_ecr_lifecycle_policy.this :
      alltrue([for rule in jsondecode(policy.policy).rules :
        rule.selection.tagStatus == "untagged" && rule.selection.countType == "sinceImagePushed" && rule.selection.countNumber == 7
      ])
    ])
    error_message = "Tagged operations, migration and rollback images must survive repeated app releases. Only untagged images expire after seven days."
  }
}
