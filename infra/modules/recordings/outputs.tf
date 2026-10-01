output "bucket_name" {
  description = "Call audio bucket name: the worker's FSS_CALL_AUDIO_BUCKET."
  value       = aws_s3_bucket.audio.bucket
}

output "bucket_arn" {
  description = "Call audio bucket ARN."
  value       = aws_s3_bucket.audio.arn
}

output "policy_json" {
  description = "Rendered bucket policy, for offline assertions."
  value       = jsonencode(local.policy_document)
}
