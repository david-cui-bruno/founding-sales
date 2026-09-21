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

run "production_defaults_are_recoverable_and_protected" {
  command = plan

  assert {
    condition     = aws_db_instance.main.engine == "postgres" && startswith(aws_db_instance.main.engine_version, "16")
    error_message = "The design targets PostgreSQL 16."
  }

  assert {
    condition     = aws_db_instance.main.multi_az
    error_message = "The default posture is Multi-AZ."
  }

  assert {
    condition     = aws_db_instance.main.storage_encrypted
    error_message = "Storage must be encrypted."
  }

  assert {
    condition     = aws_kms_key.database.enable_key_rotation
    error_message = "The database customer key must rotate."
  }

  assert {
    condition     = aws_db_instance.main.backup_retention_period == 35
    error_message = "Point-in-time recovery needs the 35-day automated backup window from the retention table."
  }

  assert {
    condition     = aws_db_instance.main.deletion_protection
    error_message = "Deletion protection is the default posture."
  }

  assert {
    condition     = aws_db_instance.main.skip_final_snapshot == false && aws_db_instance.main.final_snapshot_identifier == "fss-test-pg-final"
    error_message = "A protected instance must name a final snapshot."
  }

  assert {
    condition     = aws_db_instance.main.publicly_accessible == false
    error_message = "RDS is private and reachable only from the two task security groups."
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password
    error_message = "The master password must be generated and held by RDS, never by Terraform."
  }

  assert {
    condition     = contains(aws_db_instance.main.enabled_cloudwatch_logs_exports, "postgresql")
    error_message = "PostgreSQL logs must reach CloudWatch."
  }
}

run "parameter_group_logs_slow_statements_and_forces_tls" {
  command = plan

  assert {
    condition     = aws_db_parameter_group.main.family == "postgres16"
    error_message = "Parameter group family must match the engine major version."
  }

  assert {
    condition = length([
      for parameter in aws_db_parameter_group.main.parameter :
      parameter if parameter.name == "log_min_duration_statement" && parameter.value == "1000"
    ]) == 1
    error_message = "log_min_duration_statement must be set from the module variable."
  }

  assert {
    condition = length([
      for parameter in aws_db_parameter_group.main.parameter :
      parameter if parameter.name == "rds.force_ssl" && parameter.value == "1"
    ]) == 1
    error_message = "Connections must be TLS only."
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

run "rehearsal_may_be_single_az_and_destroyable" {
  command = plan

  variables {
    multi_az              = false
    deletion_protection   = false
    skip_final_snapshot   = true
    backup_retention_days = 1
    instance_class        = "db.t4g.micro"
  }

  assert {
    condition     = aws_db_instance.main.deletion_protection == false && aws_db_instance.main.skip_final_snapshot
    error_message = "A destroyable rehearsal root must be able to tear its database down."
  }

  assert {
    condition     = aws_db_instance.main.storage_encrypted
    error_message = "Rehearsal is still encrypted with a customer key."
  }
}

run "a_retention_longer_than_the_rds_maximum_is_refused" {
  command = plan

  variables {
    backup_retention_days = 36
  }

  expect_failures = [var.backup_retention_days]
}

# Which key the storage is encrypted with, asserted where the value exists.
#
# `aws_kms_key.database.arn` is computed, and the mock provider supplies mocked
# values during the apply phase, so this comparison cannot be made during a plan
# any more than a real one could. An apply run under a mocked provider reaches
# nothing and needs no credential. The distinction this keeps alive is the one
# that matters: the module's own customer key, never the AWS-managed RDS key.
# `docs/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "the_storage_key_is_the_module_s_own_customer_key" {
  command = apply

  assert {
    condition     = aws_db_instance.main.kms_key_id == aws_kms_key.database.arn
    error_message = "Storage must be encrypted with the module's customer key, not the AWS-managed key."
  }
}
