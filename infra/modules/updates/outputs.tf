output "bucket_name" {
  description = "Private bucket holding signed Electron packages."
  value       = aws_s3_bucket.updates.bucket
}

output "bucket_arn" {
  description = "Package bucket ARN."
  value       = aws_s3_bucket.updates.arn
}

output "distribution_id" {
  description = "CloudFront distribution id, for invalidations."
  value       = aws_cloudfront_distribution.updates.id
}

output "distribution_domain_name" {
  description = "Hostname the Electron updater points at."
  value       = aws_cloudfront_distribution.updates.domain_name
}

output "bucket_policy_json" {
  description = "Rendered bucket policy, for offline assertions."
  value       = jsonencode(local.bucket_policy)
}
