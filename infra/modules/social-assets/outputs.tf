output "bucket_name" {
  description = "Call assets bucket name: the worker's FSS_CALL_AUDIO_BUCKET."
  value       = aws_s3_bucket.assets.bucket
}

output "bucket_arn" {
  description = "Call assets bucket ARN."
  value       = aws_s3_bucket.assets.arn
}

output "policy_json" {
  description = "Rendered bucket policy, for offline assertions."
  value       = jsonencode(local.policy_document)
}
