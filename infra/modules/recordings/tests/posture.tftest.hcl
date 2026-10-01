# The call-audio bucket's posture (slice C3a): private, SSE-S3, TLS only, unversioned,
# and every object gone a day after it was written. Mocked: no credential.
mock_provider "aws" {
  override_during = apply

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::fss-test-call-audio-123456789012"
      id  = "fss-test-call-audio-123456789012"
    }
  }
}

variables {
  name_prefix    = "fss-test"
  aws_account_id = "123456789012"
}

run "every_object_expires_after_one_day" {
  command = apply

  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.audio.rule) == 1
      && aws_s3_bucket_lifecycle_configuration.audio.rule[0].status == "Enabled"
      && aws_s3_bucket_lifecycle_configuration.audio.rule[0].expiration[0].days == 1
      && length(aws_s3_bucket_lifecycle_configuration.audio.rule[0].filter) == 1
    )
    error_message = "One enabled rule, over every object, expires each one a day after it was written."
  }
}

run "the_bucket_is_private_encrypted_and_kept_once" {
  command = apply

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.audio.block_public_acls,
      aws_s3_bucket_public_access_block.audio.block_public_policy,
      aws_s3_bucket_public_access_block.audio.ignore_public_acls,
      aws_s3_bucket_public_access_block.audio.restrict_public_buckets,
      aws_s3_bucket_ownership_controls.audio.rule[0].object_ownership == "BucketOwnerEnforced",
      !aws_s3_bucket.audio.force_destroy,
    ])
    error_message = "All four public-access blocks, no ACLs, and no force destroy outside a rehearsal."
  }

  assert {
    condition = (
      one([for rule in aws_s3_bucket_server_side_encryption_configuration.audio.rule : rule.apply_server_side_encryption_by_default[0].sse_algorithm]) == "AES256"
    )
    error_message = "SSE-S3, so Transcribe reads an object with no KMS grant."
  }

  assert {
    condition     = aws_s3_bucket.audio.bucket == "fss-test-call-audio-123456789012"
    error_message = "The bucket is named inside the deployment role's namespace (<prefix>*)."
  }
}

run "the_policy_denies_every_request_not_over_tls" {
  command = apply

  assert {
    condition = anytrue([
      for statement in jsondecode(output.policy_json).Statement :
      statement.Effect == "Deny"
      && statement.Condition.Bool["aws:SecureTransport"] == "false"
      && contains(statement.Action, "s3:*")
      && contains(statement.Resource, "arn:aws:s3:::fss-test-call-audio-123456789012/*")
      && contains(statement.Resource, "arn:aws:s3:::fss-test-call-audio-123456789012")
    ])
    error_message = "A Deny on s3:* over the bucket and its objects for any request whose aws:SecureTransport is false."
  }
}

run "a_longer_retention_is_refused" {
  command = plan

  variables {
    object_expiration_days = 2
  }

  expect_failures = [var.object_expiration_days]
}
