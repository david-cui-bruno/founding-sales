mock_provider "aws" {
  override_during = apply

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
  writer_role_names = ["fss-test-api-task", "fss-test-worker-task"]
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

run "a_journal_with_no_writer_is_refused" {
  command = plan

  variables {
    writer_role_names = []
  }

  expect_failures = [var.writer_role_names]
}

run "an_unknown_lock_mode_is_refused" {
  command = plan

  variables {
    object_lock_mode = "NONE"
  }

  expect_failures = [var.object_lock_mode]
}

# The rendered bucket policy, asserted where the value exists.
#
# Every statement names the bucket ARN, which is a computed attribute, so
# `output.policy_json` is unknown for the whole plan phase once the mock stops
# pretending otherwise (`override_during = apply`). A real plan is exactly as
# blind, which is why this is an apply run; under a mocked provider it reaches
# nothing and needs no credential. The alternative would be for the module to
# build the ARN from the bucket name it already knows, which is a change to a
# policy document and not to a test.
# `docs/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "the_policy_denies_deletion_and_admits_only_the_named_writers" {
  command = apply

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

  # Both task roles write: the API from its suppression routes, the worker when
  # mail sync imports a prospect opt-out (10.2). Nobody else, in either the role
  # or the assumed-role form.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      length(statement.Condition.ArnNotLike["aws:PrincipalArn"]) == 4
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:iam::123456789012:role/fss-test-api-task")
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:sts::123456789012:assumed-role/fss-test-api-task/*")
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:iam::123456789012:role/fss-test-worker-task")
      && contains(statement.Condition.ArnNotLike["aws:PrincipalArn"], "arn:aws:sts::123456789012:assumed-role/fss-test-worker-task/*")
      if statement.Sid == "DenyWritesFromAnyoneButTheTaskRoles"
    ])
    error_message = "Only the two task roles, in both their role and assumed-role forms, may put an object."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if statement.Sid == "AllowTheTaskRolesToAppendEvents"
      && contains(statement.Action, "s3:PutObject")
      && contains(statement.Principal.AWS, "arn:aws:iam::123456789012:role/fss-test-api-task")
      && contains(statement.Principal.AWS, "arn:aws:iam::123456789012:role/fss-test-worker-task")
    ]) == 1
    error_message = "Both task roles must be allowed to append events."
  }

  # The deny above is the only thing standing between "a writer" and "anybody",
  # so a writer list that is empty must be refused rather than silently open.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      !contains(statement.Action, "s3:PutObjectRetention")
      if statement.Effect == "Allow"
    ])
    error_message = "No principal is allowed to set a per-object retention; the bucket default is the only one."
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
