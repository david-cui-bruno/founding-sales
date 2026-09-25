# FSS greenfield alerting.
#
# Every threshold in spec 13.3 becomes one CloudWatch alarm over a metric the
# applications emit, and the criticals roll up into one composite alarm so the
# operator gets one notification for one incident rather than nine.
#
# Only the two composites notify (lane g62). Until then every metric alarm
# notified the topic on ALARM and on OK beside the composite, so one incident
# sent the composite's two e-mails plus two for every member it tripped: four
# to six e-mails per flap on 24 September 2026. The metric alarms keep their
# state, which is what the composites read, and send nothing themselves. Every
# metric alarm is a member of exactly one composite: severity "critical" and
# all_sequences_held in <prefix>-critical, severity "warning" in
# <prefix>-warning. tests/thresholds.tftest.hcl holds both halves.
#
# What that costs: a composite already in ALARM does not notify again when a
# second member trips, and does not send its OK until every member is clear.
# The composite's state-change reason names the member that raised it; which
# members are in ALARM now is
# `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix <prefix>`.
#
# Delivery is SNS email. That path is AWS-native: it does not use a salesperson
# Gmail grant, so "connected mailbox disconnected for 48 hours" can still be
# delivered when every mailbox is disconnected. The topic is encrypted with a
# customer key whose policy lets CloudWatch publish; the AWS-managed SNS key
# cannot be used by CloudWatch alarms.

locals {
  topic_name = "${var.name_prefix}-alerts"

  # severity: critical rolls into the critical composite, warning into the
  # warning composite. treat_missing_data is chosen per metric: "breaching"
  # for a metric that must arrive on a schedule, "notBreaching" for a metric
  # that only appears when something went wrong, "ignore" for once-a-day ones.
  alarms = {
    api_heartbeat_missed = {
      metric_name         = "ApiHeartbeat"
      statistic           = "Sum"
      comparison          = "LessThanThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = var.heartbeat_missed_checks
      datapoints_to_alarm = var.heartbeat_missed_checks
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "Three missed one-minute API heartbeats."
    }
    scheduler_heartbeat_missed = {
      metric_name         = "SchedulerHeartbeat"
      statistic           = "Sum"
      comparison          = "LessThanThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = var.heartbeat_missed_checks
      datapoints_to_alarm = var.heartbeat_missed_checks
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "Three missed one-minute scheduler passes. No new due jobs are being created."
    }
    worker_heartbeat_missed = {
      metric_name         = "WorkerHeartbeat"
      statistic           = "Sum"
      comparison          = "LessThanThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = var.heartbeat_missed_checks
      datapoints_to_alarm = var.heartbeat_missed_checks
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "Three missed one-minute worker heartbeats."
    }
    mailbox_heartbeat_missed = {
      metric_name         = "MailboxCheckHeartbeat"
      statistic           = "Sum"
      comparison          = "LessThanThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = var.heartbeat_missed_checks
      datapoints_to_alarm = var.heartbeat_missed_checks
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "Three missed one-minute mailbox checks."
    }
    today_snapshot_absent = {
      metric_name         = "TodaySnapshotMissing"
      statistic           = "Maximum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = 300
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "ignore"
      severity            = "critical"
      description         = "No Today snapshot for the workspace business date at 05:10 workspace time."
    }
    oldest_runnable_job_warning = {
      metric_name         = "OldestRunnableJobAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.oldest_job_age_warning_seconds
      period              = 60
      evaluation_periods  = 5
      datapoints_to_alarm = 5
      treat_missing_data  = "notBreaching"
      severity            = "warning"
      description         = "The oldest runnable job is older than the warning threshold."
    }
    oldest_runnable_job_critical = {
      metric_name         = "OldestRunnableJobAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.oldest_job_age_critical_seconds
      period              = 60
      evaluation_periods  = 5
      datapoints_to_alarm = 5
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "The oldest runnable job is older than the critical threshold."
    }
    gmail_watch_expiring = {
      metric_name         = "GmailWatchHoursToExpiry"
      statistic           = "Minimum"
      comparison          = "LessThanThreshold"
      threshold           = var.gmail_watch_expiry_hours
      period              = 300
      evaluation_periods  = 2
      datapoints_to_alarm = 2
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "A Gmail watch is within two days of expiry. Push stops when it lapses."
    }
    canary_stale = {
      metric_name         = "CanaryCompletionAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.canary_stale_seconds
      period              = 60
      evaluation_periods  = 2
      datapoints_to_alarm = 2
      treat_missing_data  = "breaching"
      severity            = "critical"
      description         = "The scheduler-to-worker canary has not completed within its window."
    }
    dead_job_unresolved = {
      metric_name         = "DeadJobOldestAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.dead_job_unresolved_seconds
      period              = 300
      evaluation_periods  = 2
      datapoints_to_alarm = 2
      treat_missing_data  = "notBreaching"
      severity            = "warning"
      description         = "A dead job has been unresolved for longer than the threshold."
    }
    mailbox_disconnected = {
      metric_name         = "MailboxDisconnectedHours"
      statistic           = "Maximum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = var.mailbox_disconnected_hours
      period              = 900
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "A mailbox that sent in the last 30 days has been disconnected for 48 hours."
    }
    suppression_journal_failure = {
      metric_name         = "SuppressionJournalWriteFailures"
      statistic           = "Sum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "A suppression journal write failed. Immediately critical."
    }
    restore_generation_mismatch = {
      metric_name         = "RestoreGenerationMismatches"
      statistic           = "Sum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "The database system generation does not match the operator-controlled expected generation. Immediately critical."
    }
    outbound_invariant_failure = {
      metric_name         = "OutboundSafetyInvariantFailures"
      statistic           = "Sum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "An outbound safety invariant failed. Immediately critical."
    }
    unacknowledged_critical_alert = {
      metric_name         = "UnacknowledgedCriticalAlertAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.unacknowledged_critical_seconds
      period              = 300
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "warning"
      description         = "A critical alert has been unacknowledged past its repeat interval."
    }
  }

  critical_alarm_keys = sort([for name, alarm in local.alarms : name if alarm.severity == "critical"])
  warning_alarm_keys  = sort([for name, alarm in local.alarms : name if alarm.severity == "warning"])

  topic_key_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = ["arn:aws:iam::${var.aws_account_id}:root"] }
        Action    = ["kms:*"]
        Resource  = ["*"]
      },
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
    ]
  }

  topic_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountOwnerFullControl"
        Effect    = "Allow"
        Principal = { AWS = ["arn:aws:iam::${var.aws_account_id}:root"] }
        Action    = ["SNS:Publish", "SNS:Subscribe", "SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:ListSubscriptionsByTopic"]
        Resource  = ["arn:aws:sns:*:${var.aws_account_id}:${local.topic_name}"]
      },
      {
        Sid       = "CloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com"] }
        Action    = ["SNS:Publish"]
        Resource  = ["arn:aws:sns:*:${var.aws_account_id}:${local.topic_name}"]
        Condition = {
          StringEquals = { "aws:SourceAccount" = [var.aws_account_id] }
        }
      },
      {
        Sid       = "DenyUnencryptedTransport"
        Effect    = "Deny"
        Principal = { AWS = ["*"] }
        Action    = ["SNS:Publish"]
        Resource  = ["arn:aws:sns:*:${var.aws_account_id}:${local.topic_name}"]
        Condition = { Bool = { "aws:SecureTransport" = ["false"] } }
      },
    ]
  }
}

resource "aws_kms_key" "alerts" {
  count = var.create_kms_key ? 1 : 0

  description             = "${var.name_prefix} alert topic."
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days
  policy                  = jsonencode(local.topic_key_policy)

  tags = merge(var.tags, { Name = local.topic_name })
}

resource "aws_kms_alias" "alerts" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${local.topic_name}"
  target_key_id = aws_kms_key.alerts[0].key_id
}

locals {
  topic_key_arn = var.create_kms_key ? aws_kms_key.alerts[0].arn : var.kms_key_arn
}

resource "aws_sns_topic" "alerts" {
  name              = local.topic_name
  display_name      = "FSS alerts"
  kms_master_key_id = local.topic_key_arn

  tags = merge(var.tags, { Name = local.topic_name })
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = jsonencode(local.topic_policy)
}

# Email subscriptions are pending until the recipient clicks the confirmation
# link. Terraform reports them as created either way; the runbook has the check.
resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name        = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  alarm_description = each.value.description

  namespace   = var.metric_namespace
  metric_name = each.value.metric_name
  statistic   = each.value.statistic
  period      = each.value.period

  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  evaluation_periods  = each.value.evaluation_periods
  datapoints_to_alarm = each.value.datapoints_to_alarm
  treat_missing_data  = each.value.treat_missing_data

  # A member of one composite, which is what notifies (see the top of this
  # file). The state is the product; the e-mail is the composite's.
  actions_enabled = true
  alarm_actions   = []
  ok_actions      = []

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-${replace(each.key, "_", "-")}"
    Severity = each.value.severity
  })
}

# "All active sequences unexpectedly held" needs a ratio, so it is metric math
# rather than a single metric. It fires only when there is active work to hold.
resource "aws_cloudwatch_metric_alarm" "all_sequences_held" {
  alarm_name        = "${var.name_prefix}-all-sequences-held"
  alarm_description = "Every active enrollment is held. Automation has stopped across the workspace."

  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "held_fraction"
    expression  = "IF(active > 0, held / active, 0)"
    label       = "Held fraction of active enrollments"
    return_data = true
  }

  metric_query {
    id = "active"

    metric {
      namespace   = var.metric_namespace
      metric_name = "ActiveEnrollments"
      stat        = "Maximum"
      period      = 300
    }
  }

  metric_query {
    id = "held"

    metric {
      namespace   = var.metric_namespace
      metric_name = "HeldEnrollments"
      stat        = "Maximum"
      period      = 300
    }
  }

  # A member of the critical composite, which notifies for it.
  actions_enabled = true
  alarm_actions   = []
  ok_actions      = []

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-all-sequences-held"
    Severity = "critical"
  })
}

# The two composites are the only alarms that notify the topic, on ALARM and on
# OK. Between them they name every metric alarm above exactly once.
resource "aws_cloudwatch_composite_alarm" "critical" {
  alarm_name        = "${var.name_prefix}-critical"
  alarm_description = "Any immediately critical FSS condition. One notification per incident."

  alarm_rule = join(" OR ", concat(
    [for name in local.critical_alarm_keys : "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")"],
    ["ALARM(\"${aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name}\")"],
  ))

  actions_enabled = true
  alarm_actions   = [aws_sns_topic.alerts.arn]
  ok_actions      = [aws_sns_topic.alerts.arn]

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-critical"
    Severity = "critical"
  })
}

resource "aws_cloudwatch_composite_alarm" "warning" {
  alarm_name        = "${var.name_prefix}-warning"
  alarm_description = "Any FSS warning condition."

  alarm_rule = join(" OR ", [for name in local.warning_alarm_keys : "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")"])

  actions_enabled = true
  alarm_actions   = [aws_sns_topic.alerts.arn]
  ok_actions      = [aws_sns_topic.alerts.arn]

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-warning"
    Severity = "warning"
  })
}
