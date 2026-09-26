mock_provider "aws" {
  override_during = apply

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::fss-test-updates-123456789012"
      id                          = "fss-test-updates-123456789012"
      bucket_regional_domain_name = "fss-test-updates-123456789012.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E111111111111"
      id          = "E111111111111"
      domain_name = "d111111111111.cloudfront.net"
    }
  }
}

variables {
  name_prefix    = "fss-test"
  aws_account_id = "123456789012"
}

run "the_origin_is_private_and_reached_only_through_the_distribution" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.updates.block_public_acls,
      aws_s3_bucket_public_access_block.updates.block_public_policy,
      aws_s3_bucket_public_access_block.updates.ignore_public_acls,
      aws_s3_bucket_public_access_block.updates.restrict_public_buckets,
    ])
    error_message = "The package bucket is never public."
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.updates.signing_behavior == "always" && aws_cloudfront_origin_access_control.updates.signing_protocol == "sigv4"
    error_message = "CloudFront must sign every origin request."
  }

  assert {
    condition     = aws_cloudfront_distribution.updates.default_cache_behavior[0].viewer_protocol_policy == "https-only"
    error_message = "Packages are served over HTTPS only."
  }

  assert {
    condition     = aws_s3_bucket_versioning.updates.versioning_configuration[0].status == "Enabled"
    error_message = "Earlier compatible binaries must remain retrievable for a forward rollback."
  }
}

run "a_custom_hostname_without_a_certificate_is_refused" {
  command = plan

  variables {
    aliases = ["updates.example.invalid"]
  }

  expect_failures = [aws_cloudfront_distribution.updates]
}

# Which distribution the bucket policy admits, asserted where the value exists.
#
# The condition names `aws_cloudfront_distribution.updates.arn`, a computed
# attribute, so the rendered policy is unknown for the whole plan phase, as it
# is in a real plan. An apply run under a mocked provider reaches nothing and
# needs no credential.
# `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "only_this_distribution_may_read_the_bucket" {
  command = apply

  assert {
    condition = alltrue([
      for statement in jsondecode(output.bucket_policy_json).Statement :
      contains(statement.Condition.StringEquals["AWS:SourceArn"], aws_cloudfront_distribution.updates.arn)
      if statement.Sid == "AllowOnlyThisDistribution"
    ])
    error_message = "Only this distribution may read the bucket."
  }
}
