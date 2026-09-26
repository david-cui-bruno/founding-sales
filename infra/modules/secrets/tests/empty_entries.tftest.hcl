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

run "entries_are_namespaced_and_customer_encrypted" {
  command = plan

  assert {
    condition     = length(aws_secretsmanager_secret.this) == 8
    error_message = "The default secret set is the six application entries plus the two database entries G12h added."
  }

  # G12h, David's condition of 21 September. Two entries rather than one, because
  # the whole point is that the identity that may read one may not read the other:
  # `infra/modules/cluster` gives `migration-database` to the migration execution
  # role alone and `app-runtime-database` to the two services. Both are created
  # empty here, like the other six, and Terraform never holds either value.
  assert {
    condition     = contains(keys(aws_secretsmanager_secret.this), "migration-database")
    error_message = "The migration user's credentials live in their own entry, not inside another one."
  }

  assert {
    condition     = contains(keys(aws_secretsmanager_secret.this), "app-runtime-database")
    error_message = "The services connect as app_runtime from their own entry, never as the RDS-managed master user."
  }

  assert {
    condition = (
      aws_secretsmanager_secret.this["migration-database"].name == "fss-test/migration-database"
      && aws_secretsmanager_secret.this["app-runtime-database"].name == "fss-test/app-runtime-database"
    )
    error_message = "The two database entries are two entries. One entry read by both identities would be the boundary written down and not built."
  }

  # And neither of them is part of the application secret set the cluster hands
  # to both services: they arrive through their own named inputs, under their own
  # privileges, or they do not arrive at all.
  assert {
    condition = (
      !contains(keys(output.application_secret_arns), "migration-database")
      && !contains(keys(output.application_secret_arns), "app-runtime-database")
    )
    error_message = "A database entry must not reach a task through the general application secret map as well."
  }

  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : startswith(secret.name, "fss-test/")])
    error_message = "Secret names carry the environment namespace, so rehearsal can never read a production secret by name."
  }

  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : secret.recovery_window_in_days == 30])
    error_message = "The default recovery window is 30 days."
  }
}

run "the_envelope_key_is_distinct_and_rotating" {
  command = plan

  assert {
    condition     = aws_kms_key.envelope.enable_key_rotation && aws_kms_key.secrets.enable_key_rotation
    error_message = "Both customer keys must rotate."
  }

  assert {
    condition     = aws_kms_alias.envelope.name == "alias/fss-test-envelope" && aws_kms_alias.secrets.name == "alias/fss-test-secrets"
    error_message = "The envelope key is a separate, separately aliased key from the application secrets key."
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
