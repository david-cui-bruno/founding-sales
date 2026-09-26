# FSS greenfield observability.
#
# One encrypted log group per service, 90-day retention from the retention
# table, and the metric filters that turn structured log events into the
# CloudWatch metrics the alarm module watches.
#
# Every filter below feeds an alarm, and they are the ones the spec calls
# immediately critical: a suppression journal write failure, a
# restore-generation mismatch, and an outbound safety invariant failure. They
# are derived from logs rather than from PutMetricData so that a task which is
# failing to reach CloudWatch metrics still raises them through its log stream.
# The five filters no alarm read (API and worker errors, refusals, held steps,
# dead jobs) went in wave 2 (26 September 2026).

locals {
  log_group_names = { for service in var.services : service => "/fss/${var.name_prefix}/${service}" }

  # filter name => { log group service, json pattern, metric name, optional dimensions }
  metric_filters = {
    # Both processes write the journal (10.2): the API for the commands, the worker
    # for the opt-outs mail sync records. Each logs the failure into its own log
    # group, so each group has a filter, and both publish the one metric the alarm
    # sums (lane g81). Until then only the API's group was filtered, and neither
    # process logged the event at all.
    suppression_journal_write_failed = {
      service     = "api"
      pattern     = "{ $.event = \"suppression_journal_write_failed\" }"
      metric_name = "SuppressionJournalWriteFailures"
      dimensions  = {}
    }
    suppression_journal_write_failed_worker = {
      service     = "worker"
      pattern     = "{ $.event = \"suppression_journal_write_failed\" }"
      metric_name = "SuppressionJournalWriteFailures"
      dimensions  = {}
    }
    restore_generation_mismatch = {
      service     = "worker"
      pattern     = "{ $.event = \"restore_generation_mismatch\" }"
      metric_name = "RestoreGenerationMismatches"
      dimensions  = {}
    }
    outbound_invariant_violation = {
      service     = "worker"
      pattern     = "{ $.event = \"outbound_invariant_violation\" }"
      metric_name = "OutboundSafetyInvariantFailures"
      dimensions  = {}
    }
  }

  log_group_arn_patterns = [for service in var.services : "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/fss/${var.name_prefix}/${service}"]

  alerts_key_statements = var.shared_with_alerts ? [
    {
      Sid       = "CloudWatchAlarmsPublish"
      Effect    = "Allow"
      Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com"] }
      Action    = ["kms:GenerateDataKey*", "kms:Decrypt"]
      Resource  = ["*"]
      Condition = {
        StringEquals = { "aws:SourceAccount" = [var.aws_account_id] }
      }
    },
  ] : []

  log_key_policy = {
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = ["arn:aws:iam::${var.aws_account_id}:root"] }
        Action    = ["kms:*"]
        Resource  = ["*"]
      },
      {
        Sid       = "CloudWatchLogsUsesTheKey"
        Effect    = "Allow"
        Principal = { Service = ["logs.${var.aws_region}.amazonaws.com"] }
        Action = [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ]
        Resource = ["*"]
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = local.log_group_arn_patterns }
        }
      },
    ], local.alerts_key_statements)
  }
}

resource "aws_kms_key" "logs" {
  description             = var.shared_with_alerts ? "${var.name_prefix} CloudWatch log groups and alert topic." : "${var.name_prefix} CloudWatch log groups."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days
  policy                  = jsonencode(local.log_key_policy)

  tags = merge(var.tags, { Name = "${var.name_prefix}-logs" })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name_prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.log_group_names

  name              = each.value
  retention_in_days = var.retention_days
  kms_key_id        = aws_kms_key.logs.arn

  tags = merge(var.tags, { Name = each.value })
}

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each = local.metric_filters

  name           = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.service[each.value.service].name
  pattern        = each.value.pattern

  metric_transformation {
    name       = each.value.metric_name
    namespace  = var.metric_namespace
    value      = "1"
    unit       = "Count"
    dimensions = each.value.dimensions

    # Absence of the event is zero, not missing data, so an alarm on a safety
    # metric does not sit in INSUFFICIENT_DATA forever waiting for a failure.
    default_value = length(each.value.dimensions) == 0 ? 0 : null
  }
}
