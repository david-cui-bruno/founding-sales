# FSS suppression journal.
#
# The one pre-acknowledgement write outside PostgreSQL. A suppression event is
# written here, object-locked, before the command is acknowledged; a lost
# journal write fails the command. After a database restore the worker replays
# this bucket from the restore point minus one hour (Appendix E step 2), so the
# worker needs read and nobody needs delete.
#
# Both task roles write. The API records suppressions from its three write
# routes; the worker records prospect opt-outs while mail sync reads them, and
# 10.2 requires the journal write before acknowledgement either way. Neither
# deletes.
#
# The bucket policy is written as deny-first: deletion and lock weakening are
# denied to every principal, and PutObject is denied to every principal whose
# ARN is not one of the named writer roles. Allow statements alone would leave
# an administrator able to delete history; these denies do not.

locals {
  bucket_name = "${var.name_prefix}-suppression-journal-${var.aws_account_id}"

  writer_role_arns = [for role in var.writer_role_names : "arn:aws:iam::${var.aws_account_id}:role/${role}"]

  # Both the role ARN and the ARN a task presents once it has assumed the role.
  writer_principal_patterns = flatten([
    for role in var.writer_role_names : [
      "arn:aws:iam::${var.aws_account_id}:role/${role}",
      "arn:aws:sts::${var.aws_account_id}:assumed-role/${role}/*",
    ]
  ])

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

  # The exemption the root names, AND-ed into each deny's own condition.
  #
  # Conditions inside one statement are conjunctive, so a deny carrying both
  # `ArnNotLike` (not a writer) and `ArnNotEquals` (not an administrator) fires
  # only for a principal that is neither. With the list empty this is `{}` and
  # the key is omitted from the statement entirely: `"Condition": {}` is a
  # statement that claims a condition and has none, and a reader of a production
  # bucket policy should see no exemption at all rather than an empty one.
  #
  # `DenyUnencryptedTransport` never takes it. A teardown reaches S3 over TLS
  # like everything else, and an exemption there would be a hole with no use.
  administrative_exemption = length(var.administrative_principal_arns) == 0 ? {} : {
    ArnNotEquals = { "aws:PrincipalArn" = var.administrative_principal_arns }
  }

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
        merge({
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
          length(local.administrative_exemption) == 0 ? {} : { Condition = local.administrative_exemption },
        ),
        {
          Sid       = "DenyWritesFromAnyoneButTheTaskRoles"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:PutObject"]
          Resource  = ["${aws_s3_bucket.journal.arn}/*"]
          Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.writer_principal_patterns } }, local.administrative_exemption)
        },
        {
          Sid       = "DenyReadsFromAnyoneButTheTaskRoles"
          Effect    = "Deny"
          Principal = { AWS = ["*"] }
          Action    = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
          Resource  = local.bucket_resources
          Condition = merge({ ArnNotLike = { "aws:PrincipalArn" = local.reader_principal_patterns } }, local.administrative_exemption)
        },
        {
          Sid       = "AllowTheTaskRolesToAppendEvents"
          Effect    = "Allow"
          Principal = { AWS = local.writer_role_arns }
          Action    = ["s3:PutObject"]
          Resource  = ["${aws_s3_bucket.journal.arn}/*"]
        },
      ],
      length(local.reader_role_arns) == 0 ? [] : [
        {
          Sid       = "AllowTheTaskRolesToReplayTheJournal"
          Effect    = "Allow"
          Principal = { AWS = distinct(concat(local.writer_role_arns, local.reader_role_arns)) }
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
