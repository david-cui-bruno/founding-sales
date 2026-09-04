# All IAM entities live under path /callie-sourcing/ in this shared account.

# ---------------------------------------------------------------------------
# Lambda execution roles: one role per function group, least privilege.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- Mail parse group: read raw-mail, write inbox, dynamo idempotency ------

resource "aws_iam_role" "lambda_mail_parse" {
  name               = "${var.name_prefix}-lambda-mail-parse"
  path               = var.iam_path
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_mail_parse" {
  statement {
    sid       = "ReadRawMail"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.raw_mail.arn}/raw-mail/*"]
  }

  statement {
    sid       = "WriteInbox"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/*"]
  }

  statement {
    sid    = "IdempotencyTable"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.idempotency.arn]
  }

  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-mail-parse*"]
  }
}

resource "aws_iam_role_policy" "lambda_mail_parse" {
  name   = "${var.name_prefix}-lambda-mail-parse"
  role   = aws_iam_role.lambda_mail_parse.id
  policy = data.aws_iam_policy_document.lambda_mail_parse.json
}

# --- Adapters group: dynamo snapshots/entities, write inbox ----------------
# Role is defined now so adapter Lambdas added later share it.

resource "aws_iam_role" "lambda_adapters" {
  name               = "${var.name_prefix}-lambda-adapters"
  path               = var.iam_path
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_adapters" {
  statement {
    sid    = "SnapshotsAndEntities"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      # adapter-boston-assessments sweeps the whole (small) entities table.
      "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.snapshots.arn,
      aws_dynamodb_table.entities.arn,
      "${aws_dynamodb_table.entities.arn}/index/*",
    ]
  }

  # Adapters claim idempotency keys before emitting events (adapterRuntime).
  statement {
    sid    = "IdempotencyTable"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = [aws_dynamodb_table.idempotency.arn]
  }

  statement {
    sid       = "WriteInbox"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/*"]
  }

  # The scorer re-reads inbox events to score them.
  statement {
    sid       = "ListInbox"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.inbox.arn]
  }

  statement {
    sid       = "ReadInbox"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/*"]
  }

  # Enricher: suppression check before any contact-bearing event reaches the
  # inbox (CONTRACT.md compliance invariant). Read-only by design.
  statement {
    sid       = "SuppressionRead"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.suppression.arn]
  }

  # Enricher: spend-cap alarm (published once per month when the vendor
  # credit cap is first hit).
  statement {
    sid       = "PublishOpsAlerts"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }

  # Enricher: membership HMAC salt (shared secret with the Mac app) for
  # suppression-table lookups. SecureString under the aws/ssm managed key,
  # so ssm:GetParameter alone suffices.
  statement {
    sid       = "ReadMembershipHmacSalt"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:parameter/callie-sourcing/membership-hmac-salt"]
  }

  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-adapter-*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-scorer*",
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-enricher*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_adapters" {
  name   = "${var.name_prefix}-lambda-adapters"
  role   = aws_iam_role.lambda_adapters.id
  policy = data.aws_iam_policy_document.lambda_adapters.json
}

# ---------------------------------------------------------------------------
# Mac app inbox user: read-only access to the inbox bucket, nothing else.
# IMPORTANT: the access key is created MANUALLY (aws iam create-access-key)
# and stored in the Mac app's Keychain. Never create it in Terraform, so the
# secret never lands in TF state.
# ---------------------------------------------------------------------------

resource "aws_iam_user" "app_inbox" {
  name = "${var.name_prefix}-app-inbox"
  path = var.iam_path
}

data "aws_iam_policy_document" "app_inbox" {
  statement {
    sid       = "ListInbox"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.inbox.arn]
  }

  statement {
    sid       = "ReadInboxObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/*"]
  }

  # Privacy-preserving upstream sync: the app may write ONLY under upstream/
  # (membership sets and outcome labels; no names or free text by schema).
  statement {
    sid       = "WriteUpstream"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/upstream/*"]
  }
}

resource "aws_iam_user_policy" "app_inbox" {
  name   = "${var.name_prefix}-app-inbox-read"
  user   = aws_iam_user.app_inbox.name
  policy = data.aws_iam_policy_document.app_inbox.json
}

# ---------------------------------------------------------------------------
# Suppression-sync: the ONLY principal with write access to the suppression
# table. Reads app opt-out HMAC uploads from the inbox, writes hashes the
# enricher then checks (read-only) before emitting contact-bearing events.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "lambda_suppression_sync" {
  name               = "${var.name_prefix}-lambda-suppression-sync"
  path               = var.iam_path
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda_suppression_sync" {
  statement {
    sid       = "ListInbox"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.inbox.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["upstream/suppression/*"]
    }
  }

  statement {
    sid       = "ReadUploads"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.inbox.arn}/upstream/suppression/*"]
  }

  statement {
    sid       = "WriteReplayReports"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/upstream/suppression-reports/*"]
  }

  statement {
    sid       = "LedgerReadWrite"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.snapshots.arn]
  }

  statement {
    sid       = "SuppressionWrite"
    effect    = "Allow"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.suppression.arn]
  }

  statement {
    sid       = "SuppressionReconcile"
    effect    = "Allow"
    actions   = ["dynamodb:BatchGetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.suppression.arn]
  }

  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-suppression-sync*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda_suppression_sync" {
  name   = "${var.name_prefix}-lambda-suppression-sync"
  role   = aws_iam_role.lambda_suppression_sync.id
  policy = data.aws_iam_policy_document.lambda_suppression_sync.json
}
