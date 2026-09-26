# The daily alarm digest (lane g99; the owner's decision 11C of 25 September 2026).
#
# No alarm e-mails anybody when it trips: every alarm and composite in main.tf carries
# no action. Once a day, at 07:00 America/New_York, EventBridge Scheduler invokes one
# Lambda function that lists every alarm whose name starts with "<prefix>-", reads the
# last 24 hours of their history, and publishes one plain-text message to the alert
# topic above: what is not OK now, then the day's state changes in time order, or one
# line when nothing happened. The topic's e-mail subscriptions are unchanged, so the
# digest reaches whoever `alert_emails` names.
#
# Which alarms are in ALARM this minute is still one read away:
# `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix <prefix>-`.
#
# The source is plain JavaScript under infra/lambdas/alarm-digest, zipped here by
# `archive_file`; there is no build step. Its function, its log group and its two roles
# are named from the prefix like everything else in the stack, so the deployment roles'
# namespace statements cover them.

locals {
  digest_name           = "${var.name_prefix}-alarm-digest"
  digest_log_group_name = "/fss/${var.name_prefix}/alarm-digest"
  digest_source_dir     = "${path.module}/../../lambdas/alarm-digest"

  # 07:00 in New York all year: Scheduler evaluates the cron in the named zone, so the
  # digest does not move an hour at the daylight-saving changes.
  digest_schedule_expression = "cron(0 7 * * ? *)"
  digest_time_zone           = "America/New_York"

  # nodejs22.x rather than nodejs24.x: the AWS provider this tree pins (~> 5.60, which
  # resolves to 5.100.0) validates `runtime` against its own list, and that list ends at
  # nodejs22.x; nodejs24.x needs provider 6. The source uses nothing newer than Node 22.
  digest_runtime = "nodejs22.x"

  digest_log_retention_days = 14

  digest_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        # Read-only, and neither API can be narrowed usefully: DescribeAlarms is asked by
        # name prefix and DescribeAlarmHistory, which has no prefix, is read account-wide
        # and filtered by the function.
        Sid      = "ReadEveryAlarmAndItsHistory"
        Effect   = "Allow"
        Action   = ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory"]
        Resource = "*"
      },
      {
        Sid      = "PublishTheDigestToTheAlertTopic"
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = aws_sns_topic.alerts.arn
      },
      {
        # The topic is encrypted with a customer key, and SNS encrypts a message with the
        # publisher's own permission on that key. This key and no other.
        Sid      = "EncryptForTheAlertTopic"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.kms_key_arn
      },
      {
        Sid      = "WriteItsOwnLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.digest.arn}:*"
      },
    ]
  }

  digest_schedule_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeTheDigest"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.digest.arn
      },
    ]
  }
}

data "archive_file" "digest" {
  type             = "zip"
  output_path      = "${path.root}/.terraform/alarm-digest/${var.name_prefix}.zip"
  output_file_mode = "0644"

  source {
    filename = "index.mjs"
    content  = file("${local.digest_source_dir}/index.mjs")
  }

  source {
    filename = "digest.mjs"
    content  = file("${local.digest_source_dir}/digest.mjs")
  }
}

# Not encrypted with the log key: that key's policy admits CloudWatch Logs for the
# service log groups by name, and this group holds alarm names and states, no value.
resource "aws_cloudwatch_log_group" "digest" {
  name              = local.digest_log_group_name
  retention_in_days = local.digest_log_retention_days

  tags = merge(var.tags, { Name = local.digest_log_group_name })
}

resource "aws_iam_role" "digest" {
  name = local.digest_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, { Name = local.digest_name })
}

resource "aws_iam_role_policy" "digest" {
  name   = local.digest_name
  role   = aws_iam_role.digest.id
  policy = jsonencode(local.digest_policy)
}

resource "aws_lambda_function" "digest" {
  function_name = local.digest_name
  description   = "Once a day: every ${var.name_prefix} alarm not OK, and the day's state changes, as one e-mail."
  role          = aws_iam_role.digest.arn

  runtime       = local.digest_runtime
  architectures = ["arm64"]
  handler       = "index.handler"
  memory_size   = 128
  timeout       = 60

  filename         = data.archive_file.digest.output_path
  source_code_hash = data.archive_file.digest.output_base64sha256

  environment {
    variables = {
      FSS_ALARM_PREFIX     = "${var.name_prefix}-"
      FSS_ALERT_TOPIC_ARN  = aws_sns_topic.alerts.arn
      FSS_DIGEST_TIME_ZONE = local.digest_time_zone
    }
  }

  # Lambda encrypts the environment at rest in the caller's session. Left to the
  # AWS-managed aws/lambda key, the first production apply (25 September 2026) was
  # refused: that key carries no NamePrefix tag, so the deployment role's
  # NoDeploymentKmsDataAccessOutsideThisNamespaceOrTerraformState deny covers it. The
  # topic's key is this namespace's, which the deployment role may use and the
  # function's own role already decrypts with. The variables hold no secret.
  kms_key_arn = var.kms_key_arn

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.digest.name
  }

  tags = merge(var.tags, { Name = local.digest_name })

  # The first invocation must find the role able to write its log group and publish.
  depends_on = [aws_iam_role_policy.digest]
}

resource "aws_iam_role" "digest_schedule" {
  name = "${local.digest_name}-schedule"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
      }
    }]
  })

  tags = merge(var.tags, { Name = "${local.digest_name}-schedule" })
}

resource "aws_iam_role_policy" "digest_schedule" {
  name   = "${local.digest_name}-schedule"
  role   = aws_iam_role.digest_schedule.id
  policy = jsonencode(local.digest_schedule_policy)
}

resource "aws_scheduler_schedule" "digest" {
  name        = local.digest_name
  group_name  = "default"
  description = "The daily alarm digest, 07:00 America/New_York."
  state       = "ENABLED"

  schedule_expression          = local.digest_schedule_expression
  schedule_expression_timezone = local.digest_time_zone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.digest.arn
    role_arn = aws_iam_role.digest_schedule.arn
    input    = jsonencode({})

    # A digest that cannot be delivered within the hour is dropped rather than
    # arriving in the afternoon; the next morning's still lists whatever is not OK.
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 3
    }
  }
}
