# Offline recovery-posture contract for the FSS database module.
# Mocked plan only. No backend, no credentials, no cloud call.

# Plan-time mock values are syntactically valid and entirely fictitious.
# 123456789012 is the AWS documentation example account, never a real one.
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
  name_prefix            = "fss-test"
  subnet_ids             = ["subnet-1111111111111111a", "subnet-1111111111111111b"]
  vpc_security_group_ids = ["sg-1111111111111111a"]
}

run "the_instance_is_private_tls_only_and_holds_no_password" {
  command = plan

  assert {
    condition     = aws_db_instance.main.publicly_accessible == false
    error_message = "RDS is private and reachable only from the two task security groups."
  }

  assert {
    condition = length([
      for parameter in aws_db_parameter_group.main.parameter :
      parameter if parameter.name == "rds.force_ssl" && parameter.value == "1"
    ]) == 1
    error_message = "Connections must be TLS only."
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password
    error_message = "The master password must be generated and held by RDS, never by Terraform."
  }

  assert {
    condition     = aws_db_instance.main.storage_encrypted && aws_kms_key.database.enable_key_rotation
    error_message = "Storage is encrypted with a customer key that rotates."
  }

  assert {
    condition = (aws_db_instance.main.backup_retention_period == 35
      && aws_db_instance.main.deletion_protection
      && aws_db_instance.main.final_snapshot_identifier == "fss-test-pg-final"
    && aws_db_instance.main.delete_automated_backups == false)
    error_message = "A protected instance keeps 35 days of point-in-time recovery, names a final snapshot and keeps its automated backups when deleted."
  }
}

run "a_protected_instance_may_not_skip_its_final_snapshot" {
  command = plan

  variables {
    deletion_protection = true
    skip_final_snapshot = true
  }

  expect_failures = [aws_db_instance.main]
}

run "a_protected_instance_may_not_delete_its_automated_backups" {
  command = plan

  variables {
    deletion_protection      = true
    delete_automated_backups = true
  }

  expect_failures = [aws_db_instance.main]
}

# Run 36209569741 (26 September 2026): every deleted rehearsal database had left a
# retained automated backup. The unprotected combination plans, and takes them with it.
run "a_destroyable_instance_takes_its_backups_with_it" {
  command = plan

  variables {
    multi_az                 = false
    deletion_protection      = false
    skip_final_snapshot      = true
    delete_automated_backups = true
    backup_retention_days    = 1
  }

  assert {
    condition     = aws_db_instance.main.delete_automated_backups && aws_db_instance.main.final_snapshot_identifier == null
    error_message = "A destroyable rehearsal database leaves no final snapshot and no retained automated backup."
  }
}

run "a_retention_longer_than_the_rds_maximum_is_refused" {
  command = plan

  variables {
    backup_retention_days = 36
  }

  expect_failures = [var.backup_retention_days]
}

# Computed during apply only, which a mocked apply reaches without a credential
# (docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md).
run "the_storage_key_is_the_module_s_own_customer_key" {
  command = apply

  assert {
    condition     = aws_db_instance.main.kms_key_id == aws_kms_key.database.arn
    error_message = "Storage must be encrypted with the module's customer key, not the AWS-managed key."
  }
}
