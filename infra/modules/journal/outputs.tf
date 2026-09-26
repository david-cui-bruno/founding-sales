output "bucket_name" {
  description = "Suppression journal bucket name."
  value       = aws_s3_bucket.journal.bucket
}

output "bucket_arn" {
  description = "Suppression journal bucket ARN."
  value       = aws_s3_bucket.journal.arn
}

output "kms_key_arn" {
  description = "Customer key protecting journal objects."
  value       = aws_kms_key.journal.arn
}

output "object_lock_mode" {
  description = "Object lock mode in force."
  value       = "GOVERNANCE"
}

output "object_lock_retention_days" {
  description = "Default object lock retention in days."
  value       = var.object_lock_retention_days
}

output "policy_json" {
  description = "Rendered bucket policy, for offline assertions."
  value       = jsonencode(local.policy_document)
}
