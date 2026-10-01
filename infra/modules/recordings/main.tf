# FSS call audio: the private bucket Amazon Transcribe reads a call's recording from
# (slice C3a, David's decision of 1 October 2026).
#
# The worker's `call.transcribe` job copies one call's Twilio recording here, starts a
# Transcribe job on it, and deletes the object as soon as the job has ended
# (`apps/worker/src/transcription/awsTranscribeClient.ts`). Nothing else reads or writes
# it. A recording is the prospect's voice, personal data, so the bucket keeps nothing:
#
#   * every object expires one day after it was written — the backstop for a worker
#     that died before its own delete;
#   * versioning is never turned on (no `aws_s3_bucket_versioning`): a deleted or
#     expired object leaves no noncurrent version behind, and nothing replicates;
#   * SSE-S3 (AES256), so Transcribe can read an object with the caller's permissions
#     alone and no KMS key grant is needed;
#   * the four public-access blocks, bucket-owner-enforced ownership (no ACLs), and a
#     bucket policy denying every request that is not over TLS.
#
# The worker task role's grant on `calls/*` is in `infra/modules/cluster`. Transcribe's
# output is service-managed (no output bucket), read once over HTTPS and deleted with
# the job.

locals {
  bucket_name = "${var.name_prefix}-call-audio-${var.aws_account_id}"
}

resource "aws_s3_bucket" "audio" {
  bucket        = local.bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, { Name = local.bucket_name })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audio" {
  bucket = aws_s3_bucket.audio.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audio" {
  bucket = aws_s3_bucket.audio.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id

  rule {
    id     = "expire-every-object-after-one-day"
    status = "Enabled"

    # Every object, whatever its key.
    filter {}

    expiration {
      days = var.object_expiration_days
    }

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
        Resource  = [aws_s3_bucket.audio.arn, "${aws_s3_bucket.audio.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  }
}

resource "aws_s3_bucket_policy" "audio" {
  bucket = aws_s3_bucket.audio.id
  policy = jsonencode(local.policy_document)

  depends_on = [aws_s3_bucket_public_access_block.audio]
}
