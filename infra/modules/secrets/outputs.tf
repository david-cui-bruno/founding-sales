output "secret_arns" {
  description = "Secrets Manager ARNs keyed by logical name. References only; values are never exposed."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}

output "secret_names" {
  description = "Full Secrets Manager names keyed by logical name."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.name }
}

# The two database entries, named rather than looked up by string in the stack.
#
# A module that let its caller index `secret_arns["migration-database"]` would be a
# module whose boundary depends on a caller spelling a key correctly; these two make
# the entries part of the interface, so removing one is a plan error rather than a
# silently empty reference.

output "migration_database_secret_arn" {
  description = "Entry holding the credentials `fss migrate` connects with. Readable by the migration execution role alone."
  value       = aws_secretsmanager_secret.this["migration-database"].arn
}

output "app_runtime_database_secret_arn" {
  description = "Entry holding the `app_runtime` login user's credentials. The services' DATABASE_SECRET_ARN."
  value       = aws_secretsmanager_secret.this["app-runtime-database"].arn
}

output "application_secret_arns" {
  description = <<-EOT
    The application secrets, which is `secret_arns` without the two database
    entries. The cluster module takes this rather than the whole map, so the
    database entries reach the task definitions only through the two named
    inputs and cannot arrive twice under two different privileges.
  EOT
  value = {
    for name, secret in aws_secretsmanager_secret.this : name => secret.arn
    if name != "migration-database" && name != "app-runtime-database"
  }
}

output "secrets_kms_key_arn" {
  description = "Customer key protecting the Secrets Manager entries."
  value       = aws_kms_key.secrets.arn
}

output "envelope_kms_key_arn" {
  description = "Customer key used to envelope-encrypt per-mailbox refresh tokens before they reach PostgreSQL."
  value       = aws_kms_key.envelope.arn
}

output "envelope_kms_key_id" {
  description = "Key id of the envelope key, for application configuration."
  value       = aws_kms_key.envelope.key_id
}
