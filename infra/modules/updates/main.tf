# Signed and notarized Electron packages.
#
# The bucket is private and has no website endpoint. CloudFront reaches it
# through an origin access control, and the bucket policy admits only that one
# distribution. Package integrity is the Electron signature and the update
# manifest, not the transport, but the transport is still TLS only.

locals {
  bucket_name = "${var.name_prefix}-updates-${var.aws_account_id}"
}

resource "aws_s3_bucket" "updates" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, { Name = local.bucket_name })
}

resource "aws_s3_bucket_public_access_block" "updates" {
  bucket = aws_s3_bucket.updates.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "updates" {
  bucket = aws_s3_bucket.updates.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "updates" {
  bucket = aws_s3_bucket.updates.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "updates" {
  bucket = aws_s3_bucket.updates.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "updates" {
  bucket = aws_s3_bucket.updates.id

  rule {
    id     = "expire-superseded-packages"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.updates]
}

resource "aws_cloudfront_origin_access_control" "updates" {
  name                              = "${var.name_prefix}-updates"
  description                       = "Origin access control for the ${var.name_prefix} Electron package bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "updates" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name_prefix} Electron package distribution."
  price_class     = var.price_class
  aliases         = var.aliases

  origin {
    origin_id                = "s3-updates"
    domain_name              = aws_s3_bucket.updates.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.updates.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-updates"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 300
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }

  lifecycle {
    precondition {
      condition     = length(var.aliases) == 0 || var.acm_certificate_arn != null
      error_message = "A custom hostname needs an ACM certificate in us-east-1."
    }
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-updates" })
}

locals {
  bucket_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowOnlyThisDistribution"
        Effect    = "Allow"
        Principal = { Service = ["cloudfront.amazonaws.com"] }
        Action    = ["s3:GetObject"]
        Resource  = ["${aws_s3_bucket.updates.arn}/*"]
        Condition = {
          StringEquals = { "AWS:SourceArn" = [aws_cloudfront_distribution.updates.arn] }
        }
      },
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = { AWS = ["*"] }
        Action    = ["s3:*"]
        Resource  = [aws_s3_bucket.updates.arn, "${aws_s3_bucket.updates.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = ["false"] } }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "updates" {
  bucket = aws_s3_bucket.updates.id
  policy = jsonencode(local.bucket_policy)

  depends_on = [aws_s3_bucket_public_access_block.updates]
}
