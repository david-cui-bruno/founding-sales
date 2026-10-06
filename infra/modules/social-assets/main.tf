# Private social library. No completed-object expiry: deletion is a durable domain job.
locals {
  bucket_name = "${var.name_prefix}-social-assets-${var.aws_account_id}"
}

resource "aws_s3_bucket" "assets" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, { Name = local.bucket_name })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket = aws_s3_bucket.assets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    # Every object, whatever its key.
    filter {}


    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

locals {
  policy_document = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyRequestsThatAreNotOverTls"
        Effect    = "Deny"
        Principal = { AWS = ["*"] }
        Action    = ["s3:*"]
        Resource  = [aws_s3_bucket.assets.arn, "${aws_s3_bucket.assets.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = jsonencode(local.policy_document)

  depends_on = [aws_s3_bucket_public_access_block.assets]
}
