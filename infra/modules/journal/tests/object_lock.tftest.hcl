# The bucket's posture and its rendered policy.
#
# Every statement names the bucket ARN, which is a computed attribute, so
# `output.policy_json` is unknown for the whole plan phase once the mock stops
# pretending otherwise (`override_during = apply`). A real plan is exactly as
# blind, which is why the policy runs are apply runs; under a mocked provider they
# reach nothing and need no credential.
# `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
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
    condition = (
      aws_s3_bucket.journal.object_lock_enabled
      && aws_s3_bucket_versioning.journal.versioning_configuration[0].status == "Enabled"
      && aws_s3_bucket_object_lock_configuration.journal.rule[0].default_retention[0].mode == "GOVERNANCE"
      && aws_s3_bucket_object_lock_configuration.journal.rule[0].default_retention[0].days == 3650
    )
    error_message = "The journal is created with object lock enabled — it cannot be turned on later — over the versioning it requires, in GOVERNANCE mode for the caller's retention."
  }

  # The key the objects are encrypted with: rotated, and destroyable only after the
  # thirty-day waiting period every other key in the stack uses.
  assert {
    condition     = aws_kms_key.journal.enable_key_rotation && aws_kms_key.journal.deletion_window_in_days == 30
    error_message = "The journal key rotates and waits thirty days before it can be destroyed."
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.journal.block_public_acls,
      aws_s3_bucket_public_access_block.journal.block_public_policy,
      aws_s3_bucket_public_access_block.journal.ignore_public_acls,
      aws_s3_bucket_public_access_block.journal.restrict_public_buckets,
      !aws_s3_bucket.journal.force_destroy,
    ])
    error_message = "The journal is never public in any respect, and the default posture never empties it."
  }
}

run "a_journal_with_no_writer_is_refused" {
  command = plan

  variables {
    writer_role_names = []
  }

  expect_failures = [var.writer_role_names]
}

run "the_policy_denies_deletion_and_admits_only_the_named_writers" {
  command = apply

  # The floor under every assertion below: each reads the statement with a given
  # Sid, so a renamed or dropped statement would pass them vacuously.
  assert {
    condition = sort([for statement in jsondecode(output.policy_json).Statement : statement.Sid]) == tolist([
      "AllowTheTaskRolesToAppendEvents",
      "AllowTheTaskRolesToReplayTheJournal",
      "DenyAnyDeletionOrLockWeakening",
      "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer",
      "DenyObjectReadsFromAnyoneButTheTaskRoles",
      "DenyUnencryptedTransport",
      "DenyWritesFromAnyoneButTheTaskRoles",
    ])
    error_message = "The journal policy is these seven statements, by these names, and no others."
  }

  # Deny-first: deletion and lock weakening are denied to every principal, not
  # merely left unallowed, and the three actions the 21 September teardown was
  # refused are named.
  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement : statement
      if statement.Sid == "DenyAnyDeletionOrLockWeakening"
      && statement.Effect == "Deny"
      && contains(statement.Principal.AWS, "*")
      && contains(statement.Action, "s3:DeleteObject")
      && contains(statement.Action, "s3:DeleteObjectVersion")
      && contains(statement.Action, "s3:BypassGovernanceRetention")
      && contains(statement.Action, "s3:PutBucketObjectLockConfiguration")
      && contains(statement.Action, "s3:DeleteBucketPolicy")
    ]) == 1
    error_message = "Deletion, version deletion, governance bypass, lock reconfiguration and dropping the policy itself must be denied to every principal."
  }

  # Both task roles write: the API from its suppression routes, the worker when
  # mail sync imports a prospect opt-out (10.2). Nobody else, in either the role
  # or the assumed-role form. And no Allow sets a per-object retention: the
  # bucket default is the only one.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      (statement.Sid == "DenyWritesFromAnyoneButTheTaskRoles" ? sort(statement.Condition.ArnNotLike["aws:PrincipalArn"]) == tolist([
        "arn:aws:iam::123456789012:role/fss-test-api-task",
        "arn:aws:iam::123456789012:role/fss-test-worker-task",
        "arn:aws:sts::123456789012:assumed-role/fss-test-api-task/*",
        "arn:aws:sts::123456789012:assumed-role/fss-test-worker-task/*",
      ]) : true)
      && (statement.Sid == "AllowTheTaskRolesToAppendEvents" ? contains(statement.Action, "s3:PutObject")
        && contains(statement.Principal.AWS, "arn:aws:iam::123456789012:role/fss-test-api-task")
      && contains(statement.Principal.AWS, "arn:aws:iam::123456789012:role/fss-test-worker-task") : true)
      && (statement.Effect == "Allow" ? !contains(statement.Action, "s3:PutObjectRetention") : true)
    ])
    error_message = "Only the two task roles, in both their forms, may append an event, and no principal may set a per-object retention."
  }

  # Reads are two statements, not one (G37). Content and the version list are
  # denied to everyone but the task roles; enumerating keys is denied in its own
  # statement, on the bucket ARN, so the deployer can be let through that one and
  # no other. `s3:ListBucket` in the object-reads deny was the 23 September shape:
  # a deny anywhere is final, so the listing exemption would have counted for
  # nothing. The worker still reads the journal to replay after a restore, and
  # plain HTTP is denied.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      (statement.Sid == "DenyObjectReadsFromAnyoneButTheTaskRoles" ? statement.Effect == "Deny"
        && contains(statement.Principal.AWS, "*")
        && contains(statement.Action, "s3:GetObject")
        && contains(statement.Action, "s3:GetObjectVersion")
        && contains(statement.Action, "s3:ListBucketVersions")
      && !contains(statement.Action, "s3:ListBucket") : true)
      && (statement.Sid == "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer" ? statement.Effect == "Deny"
        && contains(statement.Principal.AWS, "*")
        && statement.Action == ["s3:ListBucket"]
      && statement.Resource == ["arn:aws:s3:::fss-test-suppression-journal-123456789012"] : true)
    ])
    error_message = "Object reads and listing must be denied in two statements: content and versions in one, s3:ListBucket alone on the bucket ARN in the other."
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement : statement
      if statement.Sid == "AllowTheTaskRolesToReplayTheJournal" || statement.Sid == "DenyUnencryptedTransport"
    ]) == 2
    error_message = "The worker must be able to read the journal to replay suppressions after a restore, and plain HTTP must be denied."
  }
}

# The deny exemptions the roots name (G16, G37).
#
# `administrative_principal_arns` is how the bucket's own deployer gets through the
# deny that stopped the fourth credentialed rehearsal's teardown (Actions run
# 35628963637: `S3 DeleteBucketPolicy … 403 AccessDenied because of an explicit deny
# in the resource-based policy`), and `bucket_listing_principal_arns` through the one
# that stopped the first production apply: `HeadBucket` is authorised as
# `s3:ListBucket`, and the provider read the 403 as "the bucket is gone".
#
# ## The vacuous-pass trap
#
# An exemption asserted only in its non-empty form would pass against a module that
# exempted the deployer always — production's posture inverted. One asserted only on
# the deletion deny would pass against the 21 September shape, where the bucket could
# be emptied and not deleted. Asserting each exemption separately would pass against
# a map merge that drops one of two `ArnNotEquals` keys. Closed by running both
# states of each variable, requiring the *absence* of the condition key when the list
# is empty, counting the combined list, and requiring the object-read deny to stay
# un-exempted when only the listing principal is named.
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

  # The positive control for the assertion above: the three principal-scoped denies
  # keep their own condition, so "no ArnNotEquals" is not true because the
  # conditions went away.
  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if can(statement.Condition.ArnNotLike["aws:PrincipalArn"])
    ]) == 3
    error_message = "The write, object-read and listing denies are still scoped by the writer and reader patterns."
  }
}

run "a_named_administrator_is_exempted_from_every_deny_but_the_transport_one" {
  command = apply

  variables {
    administrative_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
  }

  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement : statement
      if statement.Effect == "Deny"
      && statement.Sid != "DenyUnencryptedTransport"
      && contains(try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], []), "arn:aws:iam::123456789012:role/fss-test-deploy")
    ]) == 4
    error_message = "All four non-transport denies must exempt the named administrator: deletion and lock weakening, writes, object reads, and listing. Emptying a bucket you cannot then delete is where the fourth credentialed rehearsal stopped."
  }

  # Merged, not replaced. Conditions inside one statement are conjunctive, so a
  # deny carrying both keys fires only for a principal that is neither a writer nor
  # an administrator; a replacement would have opened the journal to everything
  # that is not the deployer. Plain HTTP stays denied to everybody.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      (statement.Sid == "DenyWritesFromAnyoneButTheTaskRoles" || statement.Sid == "DenyObjectReadsFromAnyoneButTheTaskRoles"
        ? can(statement.Condition.ArnNotLike["aws:PrincipalArn"]) && can(statement.Condition.ArnNotEquals["aws:PrincipalArn"])
      : true)
      && (statement.Sid == "DenyUnencryptedTransport"
        ? !can(statement.Condition.ArnNotEquals) && can(statement.Condition.Bool["aws:SecureTransport"])
      : true)
    ])
    error_message = "The exemption is merged into each statement's own condition, never in place of it, and the transport deny carries none."
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
  # exempts nobody. Either way it is not what the caller meant. A bare role name is
  # refused by the same validation.
  expect_failures = [var.administrative_principal_arns]
}

run "a_named_listing_principal_may_enumerate_the_bucket_and_read_nothing" {
  command = apply

  variables {
    bucket_listing_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      contains(try(statement.Condition.ArnNotEquals["aws:PrincipalArn"], []), "arn:aws:iam::123456789012:role/fss-test-deploy")
      && can(statement.Condition.ArnNotLike["aws:PrincipalArn"])
      if statement.Sid == "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"
    ])
    error_message = "The listing deny must exempt the principal the root named, merged into its own reader condition rather than in place of it, or the deployer cannot HeadBucket the bucket it created."
  }

  # Listing only. Naming a principal here must not move one object, one object
  # version or the version list within its reach.
  assert {
    condition = length([
      for statement in jsondecode(output.policy_json).Statement :
      statement if statement.Effect == "Deny" && can(statement.Condition.ArnNotEquals)
    ]) == 1
    error_message = "Only the listing deny may carry an exemption when only the listing variable is set. Deletion, writes and object reads stay denied to the deployer."
  }
}

run "both_exemptions_meet_in_one_arnnotequals_list" {
  command = apply

  variables {
    administrative_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-admin"]
    bucket_listing_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
  }

  # Two lists, one condition key. Merging two maps would keep whichever came last
  # and drop the other exemption without saying so. And the listing principal gets
  # no further than listing: the object-read deny carries the administrator alone.
  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      (statement.Sid == "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"
        ? sort(statement.Condition.ArnNotEquals["aws:PrincipalArn"]) == tolist([
          "arn:aws:iam::123456789012:role/fss-test-admin",
          "arn:aws:iam::123456789012:role/fss-test-deploy",
      ]) : true)
      && (statement.Sid == "DenyObjectReadsFromAnyoneButTheTaskRoles"
        ? statement.Condition.ArnNotEquals["aws:PrincipalArn"] == ["arn:aws:iam::123456789012:role/fss-test-admin"]
      : true)
    ])
    error_message = "With both variables set the listing deny exempts both principals from one ArnNotEquals list, and the object-read deny exempts the administrator alone."
  }
}

run "one_role_named_twice_is_exempted_once" {
  command = apply

  # What both roots do: the deployment role is the listing principal, and in a
  # rehearsal it is the administrative principal as well.
  variables {
    administrative_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
    bucket_listing_principal_arns = ["arn:aws:iam::123456789012:role/fss-test-deploy"]
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.policy_json).Statement :
      statement.Condition.ArnNotEquals["aws:PrincipalArn"] == ["arn:aws:iam::123456789012:role/fss-test-deploy"]
      if statement.Sid == "DenyListingFromAnyoneButTheTaskRolesAndTheDeployer"
    ])
    error_message = "A role named by both variables belongs in the condition once."
  }
}

run "a_listing_principal_that_is_not_an_exact_role_arn_is_refused" {
  command = plan

  variables {
    bucket_listing_principal_arns = ["arn:aws:iam::123456789012:role/*"]
  }

  expect_failures = [var.bucket_listing_principal_arns]
}
