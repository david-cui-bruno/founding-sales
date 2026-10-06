mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::fss-test-social-assets-123456789012"
      id = "fss-test-social-assets-123456789012"
    }
  }
}
variables {
  name_prefix = "fss-test"
  aws_account_id = "123456789012"
}
run "private_library_is_separate_from_expiring_audio" {
  command = apply
  assert {
    condition = aws_s3_bucket.assets.bucket == "fss-test-social-assets-123456789012" && !aws_s3_bucket.assets.force_destroy
    error_message = "Library cannot use the one-day audio bucket."
  }
  assert {
    condition = alltrue([aws_s3_bucket_public_access_block.assets.block_public_acls,aws_s3_bucket_public_access_block.assets.block_public_policy,aws_s3_bucket_public_access_block.assets.ignore_public_acls,aws_s3_bucket_public_access_block.assets.restrict_public_buckets])
    error_message = "All public access must be blocked."
  }
  assert {
    condition = length(aws_s3_bucket_lifecycle_configuration.assets.rule[0].expiration)==0 && aws_s3_bucket_lifecycle_configuration.assets.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation==1
    error_message = "Completed assets remain; abandoned multipart uploads expire."
  }
  assert {
    condition = one([for rule in aws_s3_bucket_server_side_encryption_configuration.assets.rule:rule.apply_server_side_encryption_by_default[0].sse_algorithm])=="AES256"
    error_message = "Private assets must be encrypted."
  }
}
