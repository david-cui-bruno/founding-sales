output "bucket_name" {
  description = "Private bucket holding signed Electron packages."
  value       = aws_s3_bucket.updates.bucket
}

output "distribution_domain_name" {
  description = "Hostname the Electron updater points at."
  value       = aws_cloudfront_distribution.updates.domain_name
}
