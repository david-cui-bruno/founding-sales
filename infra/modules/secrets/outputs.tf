output "secret_arns" {
  description = "Secrets Manager ARNs keyed by logical name. References only; values are never exposed."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
}

output "secret_names" {
  description = "Full Secrets Manager names keyed by logical name."
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.name }
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
