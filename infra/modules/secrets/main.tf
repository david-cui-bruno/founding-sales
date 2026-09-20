# FSS greenfield secret material.
#
# Two customer keys and a set of EMPTY Secrets Manager entries.
#
# This module deliberately contains no aws_secretsmanager_secret_version and no
# random_password. Terraform creates the container; a human puts the value in
# once, following docs/greenfield/infra-apply-runbook.md. Nothing secret is ever
# in the repository, in a plan, or in state.
#
# The envelope key is separate from the application key. Per-mailbox Gmail
# refresh tokens are envelope-encrypted before they reach PostgreSQL, so the
# key that unwraps them is used only by the two task roles and is rotated and
# audited independently of the general application secrets.

resource "aws_kms_key" "secrets" {
  description             = "${var.name_prefix} application secrets in Secrets Manager."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-secrets" })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_kms_key" "envelope" {
  description             = "${var.name_prefix} envelope key for per-mailbox Gmail refresh tokens stored in PostgreSQL."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-envelope" })
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/${var.name_prefix}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.secret_names)

  name                    = "${var.name_prefix}/${each.value}"
  description             = "Created empty by Terraform. The value is entered by hand under the apply runbook."
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = var.recovery_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.value}" })
}
