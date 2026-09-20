mock_provider "aws" {
  override_during = plan

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
      id  = "fss-test-suppression-journal-123456789012"
    }
  }
}

variables {
  name_prefix       = "fss-test"
  aws_account_id    = "123456789012"
  writer_role_name  = "fss-test-api-task"
  reader_role_names = ["fss-test-worker-task"]
}

run "the_bucket_is_versioned_locked_and_private" {
  command = plan

  assert {
    condition     = aws_s3_bucket.journal.object_lock_enabled
    error_message = "The journal must be created with object lock enabled; it cannot be turned on later."
  }

  assert {
    condition     = aws_s3_bucket_versioning.journal.versioning_configuration[0].status == "Enabled"
    error_message = "Object lock requires versioning."
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.journal.rule[0].default_retention[0].mode == "GOVERNANCE"
    error_message = "The default lock mode is GOVERNANCE, with COMPLIANCE available by variable."
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.journal.rule[0].default_retention[0].days == 3650
    error_message = "Suppression history is retained indefinitely; the production default is a long lock."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.journal.block_public_acls,
      aws_s3_bucket_public_access_block.journal.block_public_policy,
      aws_s3_bucket_public_access_block.journal.ignore_public_acls,
      aws_s3_bucket_public_access_block.journal.restrict_public_buckets,
    ])
    error_message = "The journal is never public in any respect."
  }

  assert {
    condition     = aws_s3_bucket.journal.force_destroy == false
    error_message = "The default posture never empties the journal."
  }
}

run "the_policy_denies_deletion_and_admits_only_the_api_task_role_to_write" {
  command = plan

  assert {
    condition     = length([for statement in jsondecode(output.policy_json).Statement : statement if statement.Sid == "DenyAnyDeletionOrLockWeakening" && statement.Effect == "Deny" && contains(statement.Principal.AWS, "*")]) == 1
    error_message = "Deletion and lock weakening must be denied to every principal, not merely left unallowed."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      contains(statement.Action, "s3:DeleteObject") && contains(statement.Action, "s3:DeleteObjectVersion") && contains(statement.Action, "s3:BypassGovernanceRetention") && contains(statement.Action, "s3:PutBucketObjectLockConfiguration")
      if statement.Sid == "DenyAnyDeletionOrLockWeakening"
    ])
    error_message = "The deny must cover object deletion, version deletion, governance bypass and lock reconfiguration."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      length(statement.Condition.ArnNotLike["aws:PrincipalArn"]) == 2
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:iam::123456789012:role/fss-test-api-task")
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:sts::123456789012:assumed-role/fss-test-api-task/*")
      if statement.Sid == "DenyWritesFromAnyoneButTheApiTaskRole"
    ])
    error_message = "Only the API task role, in both its role and assumed-role forms, may put an object."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if statement.Sid == "AllowTheApiTaskRoleToAppendEvents" && contains(statement.Action, "s3:PutObject") && contains(statement.Principal.AWS, "arn:aws:iam::123456789012:role/fss-test-api-task")
    ]) == 1
    error_message = "The API task role must be allowed to append events."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if statement.Sid == "AllowTheTaskRolesToReplayTheJournal"
    ]) == 1
    error_message = "The worker must be able to read the journal to replay suppressions after a restore."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if statement.Sid == "DenyUnencryptedTransport"
    ]) == 1
    error_message = "Plain HTTP must be denied."
  }
}

run "compliance_mode_is_available_by_variable" {
  command = plan

  variables {
    object_lock_mode           = "COMPLIANCE"
    object_lock_retention_days = 30
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.journal.rule[0].default_retention[0].mode == "COMPLIANCE"
    error_message = "COMPLIANCE mode must be selectable."
  }
}

run "an_unknown_lock_mode_is_refused" {
  command = plan

  variables {
    object_lock_mode = "NONE"
  }

  expect_failures = [var.object_lock_mode]
}
