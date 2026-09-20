# FSS suppression journal.
#
# The one pre-acknowledgement write outside PostgreSQL. A suppression event is
# written here, object-locked, before the command is acknowledged; a lost
# journal write fails the command. After a database restore the worker replays
# this bucket from the restore point minus one hour (Appendix E step 2), so the
# worker needs read and nobody needs delete.
#
# The bucket policy is written as deny-first: deletion and lock weakening are
# denied to every principal, and PutObject is denied to every principal whose
# ARN is not the API task role. Allow statements alone would leave an
# administrator able to delete history; these denies do not.

locals {
  bucket_name = "${var.name_prefix}-suppression-journal-${var.aws_account_id}"

  writer_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.writer_role_name}"

  # Both the role ARN and the ARN a task presents once it has assumed the role.
  writer_principal_patterns = [
    local.writer_role_arn,
    "arn:aws:sts::${var.aws_account_id}:assumed-role/${var.writer_role_name}/*",
  ]

  reader_principal_patterns = concat(
    local.writer_principal_patterns,
    flatten([
      for role in var.reader_role_names : [
        "arn:aws:iam::${var.aws_account_id}:role/${role}",
        "arn:aws:sts::${var.aws_account_id}:assumed-role/${role}/*",
      ]
    ])
  )

  reader_role_arns = [for role in var.reader_role_names : "arn:aws:iam::${var.aws_account_id}:role/${role}"]
}

resource "aws_kms_key" "journal" {
  description             = "${var.name_prefix} suppression journal objects."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days

  tags = merge(var.tags, { Name = "${var.name_prefix}-journal" })
}

resource "aws_kms_alias" "journal" {
  name          = "alias/${var.name_prefix}-journal"
  target_key_id = aws_kms_key.journal.key_id
}

resource "aws_s3_bucket" "journal" {
  bucket              = local.bucket_name
  force_destroy       = var.force_destroy
  object_lock_enabled = true

  tags = merge(var.tags, { Name = local.bucket_name })
}

# Object lock requires versioning and versioning can never be suspended again.
resource "aws_s3_bucket_versioning" "journal" {
  bucket = aws_s3_bucket.journal.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "journal" {
  bucket = aws_s3_bucket.journal.id

  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.object_lock_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.journal]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "journal" {
  bucket = aws_s3_bucket.journal.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.journal.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "journal" {
  bucket = aws_s3_bucket.journal.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "journal" {
  bucket = aws_s3_bucket.journal.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Written with jsonencode rather than aws_iam_policy_document so the rendered
# policy is known at plan time and the offline test can read every statement.
locals {
  bucket_resources = [aws_s3_bucket.journal.arn, "${aws_s3_bucket.journal.arn}/*"]

  policy_document = {
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid       = "DenyUnencryptedTransport"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:*"]
          Resource  = local.bucket_resources
          Condition = { Bool = { "aws:SecureTransport" = ["false"] } }
        },
        {
          Sid       = "DenyAnyDeletionOrLockWeakening"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action = [
            "s3:BypassGovernanceRetention",
            "s3:DeleteBucket",
            "s3:DeleteBucketPolicy",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
            "s3:PutBucketObjectLockConfiguration",
            "s3:PutBucketVersioning",
            "s3:PutLifecycleConfiguration",
            "s3:PutObjectLegalHold",
            "s3:PutObjectRetention",
          ]
          Resource = local.bucket_resources
        },
        {
          Sid       = "DenyWritesFromAnyoneButTheApiTaskRole"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:PutObject"]
          Resource  = ["${aws_s3_bucket.journal.arn}/*"]
          Condition = { ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }
        },
        {
          Sid       = "DenyReadsFromAnyoneButTheTaskRoles"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
          Resource  = local.bucket_resources
          Condition = { ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }
        },
        {
          Sid       = "AllowTheApiTaskRoleToAppendEvents"
          Effect    = "Allow"
          Principal = { AWS = [local.writer_role_arn] }
          Action    = ["s3:PutObject"]
          Resource  = ["${aws_s3_bucket.journal.arn}/*"]
        },
      ],
      length(local.reader_role_arns) == 0 ? [] : [
        {
          Sid       = "AllowTheTaskRolesToReplayTheJournal"
          Effect    = "Allow"
          Principal = { AWS = concat([local.writer_role_arn], local.reader_role_arns) }
          Action    = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
          Resource  = local.bucket_resources
        },
      ],
    )
  }
}

resource "aws_s3_bucket_policy" "journal" {
  bucket = aws_s3_bucket.journal.id
  policy = jsonencode(local.policy_document)

  depends_on = [aws_s3_bucket_public_access_block.journal]
}
