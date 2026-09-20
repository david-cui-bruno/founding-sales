mock_provider "aws" {
  override_during = plan

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
    condition     = length(aws_secretsmanager_secret.this) == 6
    error_message = "The default secret set is the six entries the design names."
  }

  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : startswith(secret.name, "fss-test/")])
    error_message = "Secret names carry the environment namespace, so rehearsal can never read a production secret by name."
  }

  assert {
    condition     = alltrue([for secret in aws_secretsmanager_secret.this : secret.kms_key_id == aws_kms_key.secrets.arn])
    error_message = "Every entry is encrypted with the module's customer key."
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
