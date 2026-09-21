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

# The deny exemption the root names (G16).
#
# `administrative_principal_arns` is how the bucket's own deployer gets through
# the deny that stopped the fourth credentialed rehearsal's teardown (Actions
# run 35628963637: `S3 DeleteBucketPolicy … 403 AccessDenied because of an
# explicit deny in the resource-based policy`, and the same for
# `PutBucketObjectLockConfiguration`).
#
# ## The vacuous-pass trap
#
# An exemption asserted only in its non-empty form would pass against a module
# that ignored the variable and exempted the deployer always — which is
# production's posture inverted. And an exemption asserted only on the deletion
# deny would pass against the 21 September shape, where the bucket could be
# emptied and not deleted. Closed by running both states of the variable, by
# requiring the *absence* of the condition key when the list is empty rather
# than an empty condition, by checking the merge with each statement's own
# `ArnNotLike` rather than its replacement, and by requiring the transport deny
# to stay unconditioned in both states.
run "an_empty_administrative_list_leaves_every_deny_as_it_was" {
  command = apply

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      !can(statement.Condition.ArnNotEquals)
      if statement.Effect == "Deny"
    ])
    error_message = "With nobody named, no deny may carry an exemption. An empty Condition object is a statement that claims one and has none."
  }

  # The positive control for the run below: the two principal-scoped denies keep
  # their own condition, so "no ArnNotEquals" is not true because the conditions
  # went away.
  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if can(statement.Condition.ArnNotLike["aws:PrincipalArn"])
    ]) == 2
    error_message = "The write and read denies are still scoped by the writer and reader patterns."
  }
}

run "a_named_administrator_is_exempted_from_every_deny_but_the_transport_one" {
  command = apply

  variables {
    administrative_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement
      if statement.Effect == "Deny"
      && statement.Sid != "DenyUnencryptedTransport"
      && contains(try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], []), "arn:aws:iam::123456789012:role/fss-test-deploy")
    ]) == 3
    error_message = "All three non-transport denies must exempt the named administrator: deletion and lock weakening, writes, and reads. Emptying a bucket you cannot then delete is where the fourth credentialed rehearsal stopped."
  }

  # Merged, not replaced. Conditions inside one statement are conjunctive, so a
  # deny carrying both keys fires only for a principal that is neither a writer
  # nor an administrator; a replacement would have opened the journal to
  # everything that is not the deployer.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      can(statement.Condition.ArnNotLike["aws:PrincipalArn"]) && can(statement.Condition.ArnNotEquals["aws:PrincipalArn"])
      if statement.Sid == "DenyWritesFromAnyoneButTheTaskRoles" || statement.Sid == "DenyReadsFromAnyoneButTheTaskRoles"
    ])
    error_message = "The exemption is merged into each statement's own condition, never in place of it."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      !can(statement.Condition.ArnNotEquals) && can(statement.Condition.Bool["aws:SecureTransport"])
      if statement.Sid == "DenyUnencryptedTransport"
    ])
    error_message = "Plain HTTP stays denied to every principal, deployer included."
  }

  # The deny still covers governance bypass and lock reconfiguration for
  # everybody else. The fix is an exemption, not a shorter deny.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      contains(statement.Action, "s3:BypassGovernanceRetention") && contains(statement.Action, "s3:PutBucketObjectLockConfiguration") && contains(statement.Action, "s3:DeleteBucketPolicy")
      if statement.Sid == "DenyAnyDeletionOrLockWeakening"
    ])
    error_message = "The three actions the 21 September teardown was refused stay denied to everyone the root has not named."
  }
}

run "an_administrative_principal_that_is_not_an_exact_role_arn_is_refused" {
  command = plan

  variables {
    administrative_principal_arns = ["arn:aws:iam::123456789012:role/*"]
  }

  # A pattern here would exempt every role in the account from the one deny
  # standing between suppression history and an administrator, and `ArnNotEquals`
  # would not even treat it as a pattern: it compares the literal string and
  # exempts nobody. Either way it is not what the caller meant.
  expect_failures = [var.administrative_principal_arns]
}

run "a_bare_role_name_is_refused" {
  command = plan

  variables {
    administrative_principal_arns = ["fss-test-deploy"]
  }

  expect_failures = [var.administrative_principal_arns]
}
