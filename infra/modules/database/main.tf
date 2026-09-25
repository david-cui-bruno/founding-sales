# FSS greenfield database: one Multi-AZ RDS PostgreSQL 16 instance.
#
# PostgreSQL is authoritative for business state and for the durable job queue,
# so this module is the one place where recovery posture is set: a customer KMS
# key, 35-day automated backups (which is what gives point-in-time recovery),
# deletion protection, and no public addressing.
#
# The master password is never a Terraform value. manage_master_user_password
# hands generation, storage and rotation to RDS, which writes it to a Secrets
# Manager secret encrypted with the same customer key. No password, no
# random_password resource, and nothing secret in state.

locals {
  identifier = "${var.name_prefix}-pg"
}

resource "aws_kms_key" "database" {
  description             = "${var.name_prefix} RDS PostgreSQL storage, snapshots, logs and master user secret."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-database" })
}

resource "aws_kms_alias" "database" {
  name          = "alias/${var.name_prefix}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_db_subnet_group" "main" {
  name        = "${var.name_prefix}-db"
  description = "Private subnets only. RDS has no route off the VPC."
  subnet_ids  = var.subnet_ids

  tags = merge(var.tags, { Name = "${var.name_prefix}-db" })
}

# Two parameters say `apply_method = "pending-reboot"` because that is what AWS
# reports for them in production (lane g86). With the provider's default,
# `immediate`, every production plan showed an in-place update of this group that
# changed nothing: AWS does not register a change of apply method alone, so the
# apply "succeeded" and the next plan showed it again (release.md 8.0s). The AWS
# provider documents exactly this perpetual diff for aws_db_parameter_group and
# says the code must name the method AWS holds. `ignore_changes` cannot reach one
# attribute of an element of the `parameter` set.
#
# The method only matters when a value changes. Changing either of these two
# values later takes effect at the next reboot unless the same change also sets
# `apply_method = "immediate"`, which AWS does register together with a new value.
# docs/decisions/g86-the-parameter-group-names-what-aws-holds.md.
resource "aws_db_parameter_group" "main" {
  name        = "${var.name_prefix}-pg16"
  family      = "postgres16"
  description = "${var.name_prefix} PostgreSQL 16 parameters."

  parameter {
    name  = "rds.force_ssl"
    value = "1"

    apply_method = "pending-reboot"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = tostring(var.log_min_duration_statement)
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  parameter {
    name  = "log_autovacuum_min_duration"
    value = "10000"

    apply_method = "pending-reboot"
  }

  # DDL only. Statement text of business writes never reaches CloudWatch.
  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  # The scheduler holds a transaction-scoped advisory lock for one bounded pass.
  # A session that dies holding an open transaction must not block it forever.
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "300000"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-pg16" })
}

resource "aws_iam_role" "enhanced_monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  name = "${var.name_prefix}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = "${var.name_prefix}-rds-monitoring" })
}

resource "aws_iam_role_policy_attachment" "enhanced_monitoring" {
  count = var.monitoring_interval > 0 ? 1 : 0

  role       = aws_iam_role.enhanced_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  identifier = local.identifier

  engine                      = "postgres"
  engine_version              = var.engine_version
  allow_major_version_upgrade = false
  auto_minor_version_upgrade  = true
  instance_class              = var.instance_class
  multi_az                    = var.multi_az

  db_name                       = var.database_name
  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.database.arn
  port                          = var.port

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage > 0 ? var.max_allocated_storage : null
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.main.name
  vpc_security_group_ids = var.vpc_security_group_ids
  publicly_accessible    = false
  ca_cert_identifier     = var.ca_cert_identifier

  # Automated backups with a non-zero retention are what enable point-in-time
  # recovery. 35 days is the design target and the retention-table commitment.
  backup_retention_period   = var.backup_retention_days
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${local.identifier}-final"

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_kms_key_id       = var.performance_insights_enabled ? aws_kms_key.database.arn : null
  performance_insights_retention_period = var.performance_insights_enabled ? var.performance_insights_retention_period : null

  monitoring_interval = var.monitoring_interval
  monitoring_role_arn = var.monitoring_interval > 0 ? aws_iam_role.enhanced_monitoring[0].arn : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  apply_immediately = var.apply_immediately

  lifecycle {
    precondition {
      condition     = !(var.skip_final_snapshot && var.deletion_protection)
      error_message = "A deletion-protected instance must take a final snapshot. skip_final_snapshot belongs only to a destroyable rehearsal root."
    }
  }

  tags = merge(var.tags, { Name = local.identifier })
}
