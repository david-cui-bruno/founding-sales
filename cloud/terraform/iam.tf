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
    ]
    resources = [
      aws_dynamodb_table.snapshots.arn,
      aws_dynamodb_table.entities.arn,
      "${aws_dynamodb_table.entities.arn}/index/*",
    ]
  }

  statement {
    sid       = "WriteInbox"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbox.arn}/*"]
  }

  statement {
    sid    = "Logs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/aws/lambda/${var.name_prefix}-adapter-*"]
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
}

resource "aws_iam_user_policy" "app_inbox" {
  name   = "${var.name_prefix}-app-inbox-read"
  user   = aws_iam_user.app_inbox.name
  policy = data.aws_iam_policy_document.app_inbox.json
}
