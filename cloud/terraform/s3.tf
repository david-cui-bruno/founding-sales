# ---------------------------------------------------------------------------
# Raw mail bucket: SES writes full MIME messages here (see ses.tf).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "raw_mail" {
  bucket = "${var.name_prefix}-raw-mail-${var.aws_account_id}"
}

resource "aws_s3_bucket_public_access_block" "raw_mail" {
  bucket = aws_s3_bucket.raw_mail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw_mail" {
  bucket = aws_s3_bucket.raw_mail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Raw MIME is transient input for the parser: expire after 90 days.
resource "aws_s3_bucket_lifecycle_configuration" "raw_mail" {
  bucket = aws_s3_bucket.raw_mail.id

  rule {
    id     = "expire-raw-mail"
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# Inbox bucket: SourceEvent JSON objects the Mac app polls. Versioned so a
# bad writer can't silently clobber events. Noncurrent versions are retained
# globally because suppression history must remain replayable and this shared
# bucket has no object tagging or dedicated suppression lifecycle boundary.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "inbox" {
  bucket = "${var.name_prefix}-inbox-${var.aws_account_id}"
}

resource "aws_s3_bucket_public_access_block" "inbox" {
  bucket = aws_s3_bucket.inbox.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbox" {
  bucket = aws_s3_bucket.inbox.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "inbox" {
  bucket = aws_s3_bucket.inbox.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbox" {
  bucket = aws_s3_bucket.inbox.id

  # Retain every current and noncurrent version. Only abandoned multipart
  # uploads are cleaned up until suppression objects have a dedicated bucket
  # or lifecycle tag that can safely isolate retention policy.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {
      prefix = ""
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.inbox]
}
