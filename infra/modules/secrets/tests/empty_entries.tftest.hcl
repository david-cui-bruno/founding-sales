mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }
}

variables {
  name_prefix = "fss-test"
}

run "the_two_database_identities_are_two_entries_and_both_keys_rotate" {
  command = plan

  # G12h, David's condition of 21 September: the identity that may read one may
  # not read the other. `infra/modules/cluster` gives `migration-database` to the
  # migration execution role alone and `app-runtime-database` to the two services.
  assert {
    condition = (
      aws_secretsmanager_secret.this["migration-database"].name == "fss-test/migration-database"
      && aws_secretsmanager_secret.this["app-runtime-database"].name == "fss-test/app-runtime-database"
    )
    error_message = "The two database entries are two entries. One entry read by both identities would be the boundary written down and not built."
  }

  # They arrive through their own named inputs, under their own privileges, or not at all.
  assert {
    condition = (
      !contains(keys(output.application_secret_arns), "migration-database")
      && !contains(keys(output.application_secret_arns), "app-runtime-database")
    )
    error_message = "A database entry must not reach a task through the general application secret map as well."
  }

  assert {
    condition     = aws_kms_key.envelope.enable_key_rotation && aws_kms_key.secrets.enable_key_rotation
    error_message = "Both customer keys must rotate."
  }
}

run "an_out_of_range_recovery_window_is_refused" {
  command = plan

  variables {
    recovery_window_days = 3
  }

  expect_failures = [var.recovery_window_days]
}

# The key every entry is attached to, asserted where the value exists.
#
# `aws_kms_key.secrets.arn` is computed, and the mock provider above supplies
# mocked values during the apply phase, so a plan here is as blind as a real
# one. An apply run under a mocked provider reaches nothing and needs no
# credential. `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "every_entry_is_encrypted_with_the_module_s_own_key" {
  command = apply

  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : secret.kms_key_id == aws_kms_key.secrets.arn])
    error_message = "Every entry is encrypted with the module's customer key."
  }
}
