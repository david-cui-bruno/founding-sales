# FSS greenfield alerting.
#
# Every threshold in spec 13.3 becomes one CloudWatch alarm over a metric the
# applications emit, and the alarms roll up into two composites: <prefix>-critical over
# every critical condition and <prefix>-warning over every warning. The thirteen
# per-condition composites of lane g81 went in wave 2 (26 September 2026): with no
# action on any alarm they only repeated, in the digest, a metric alarm's own state.
#
# Nothing here e-mails anybody (lane g99; the owner's decision 11C of 25 September
# 2026). No metric alarm and no composite carries an alarm, OK or insufficient-data
# action. Until then the composites e-mailed on their transitions (lanes g62 and g81);
# now the one e-mail is the daily digest in digest.tf, which at 07:00 America/New_York
# lists every alarm that is not OK and every state change of the last 24 hours. The
# alarms keep their names and their state, which is what the digest, the dashboard and
# the CLI read. Every metric alarm is still a member of exactly one roll-up: severity
# "critical" and all_sequences_held in <prefix>-critical, severity "warning" in
# <prefix>-warning. tests/thresholds.tftest.hcl holds the membership and
# tests/digest.tftest.hcl holds the absence of every action.
#
# Which members are in ALARM now is
# `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix <prefix>-`.
#
# Delivery of the digest is SNS email. That path is AWS-native: it does not use a
# salesperson Gmail grant, so "connected mailbox disconnected for 48 hours" can still be
# delivered when every mailbox is disconnected. The topic is encrypted with a customer
# key; the digest function's role may use that key and publish to this topic alone.

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
    # The age is the detection target itself (13.3: five minutes warns, fifteen is
    # critical), so one one-minute maximum above it raises the alarm. A waiting job's
    # age only grows until it is claimed, so a second consecutive breach confirms
    # nothing the first did not. Until lane g86 (audit O18) both needed five of five,
    # and fired when the oldest job had waited about ten and twenty minutes.
    oldest_runnable_job_warning = {
      metric_name         = "OldestRunnableJobAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.oldest_job_age_warning_seconds
      period              = 60
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "warning"
      description         = "A runnable job has waited longer than the warning threshold (five minutes by default). Raised by the first one-minute sample above it, one to two minutes after."
    }
    oldest_runnable_job_critical = {
      metric_name         = "OldestRunnableJobAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.oldest_job_age_critical_seconds
      period              = 60
      evaluation_periods  = 1
      datapoints_to_alarm = 1
      treat_missing_data  = "notBreaching"
      severity            = "critical"
      description         = "A runnable job has waited longer than the critical threshold (fifteen minutes by default). Raised by the first one-minute sample above it, one to two minutes after."
    }
    # Published only while a mailbox is connected, and 0 for a connected mailbox
    # with no live watch — so the state this alarm exists for always has a
    # datapoint. Missing means no connected mailbox: never connected, or
    # disconnected on purpose. Until lane g81 (audit O15) missing was breaching and
    # an environment with no mailbox sat in critical ALARM; a worker that stopped
    # publishing is the heartbeat alarms' to catch, and they still breach.
    gmail_watch_expiring = {
      metric_name         = "GmailWatchHoursToExpiry"
      statistic           = "Minimum"
      comparison          = "LessThanThreshold"
      threshold           = var.gmail_watch_expiry_hours
      period              = 300
      evaluation_periods  = 2
      datapoints_to_alarm = 2
      treat_missing_data  = "notBreaching"
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
      description         = "A mailbox that sent in the last 30 days has had its Gmail grant revoked for 48 hours. A mailbox its owner disconnected is not counted."
    }
    # Lane g81. Since lane g77 the send path holds every automated email for an owner
    # whose coverage watermark is older than fifteen minutes, and nothing outside the
    # Mac said whether sync was advancing. The worker publishes the stalest connected,
    # ready mailbox's watermark age by the gate's own rule, and nothing when no mailbox
    # is connected and ready; a warning, because the gate already holds the sends and
    # nothing unsafe follows from a stale watermark on its own.
    mailbox_coverage_stale = {
      metric_name         = "MailboxCoverageAgeSeconds"
      statistic           = "Maximum"
      comparison          = "GreaterThanThreshold"
      threshold           = var.mailbox_coverage_stale_seconds
      period              = 60
      evaluation_periods  = 3
      datapoints_to_alarm = 3
      treat_missing_data  = "notBreaching"
      severity            = "warning"
      description         = "A connected mailbox's coverage watermark has been older than fifteen minutes for three minutes. Automated email for its owner is held until sync proves coverage again."
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
    # One line fires it; it clears three quiet minutes after the last one (lane
    # g81, audit O16). The worker writes the event on every metric pass while the
    # generation it was pinned to and the database's differ, so the alarm holds for
    # as long as the mismatch does. The pass is a fixed-delay loop, a little over
    # a minute apart, so one minute in many hundreds has no line; one in three
    # keeps that minute from reading OK and sending a second ALARM e-mail.
    restore_generation_mismatch = {
      metric_name         = "RestoreGenerationMismatches"
      statistic           = "Sum"
      comparison          = "GreaterThanOrEqualToThreshold"
      threshold           = 1
      period              = 60
      evaluation_periods  = 3
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

  # A member of one roll-up. The state is the product; the daily digest (digest.tf)
  # is the only e-mail.
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

  # A member of the critical roll-up; the daily digest reports its state.
  actions_enabled = true
  alarm_actions   = []
  ok_actions      = []

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-all-sequences-held"
    Severity = "critical"
  })
}

# The two roll-ups name every metric alarm above exactly once between them. Neither
# notifies anything (lane g99): the daily digest reads their state.
resource "aws_cloudwatch_composite_alarm" "critical" {
  alarm_name        = "${var.name_prefix}-critical"
  alarm_description = "Every immediately critical FSS condition. In ALARM while any of them is; reported by the daily alarm digest, never e-mailed on its own."

  alarm_rule = join(" OR ", concat(
    [for name in local.critical_alarm_keys : "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")"],
    ["ALARM(\"${aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name}\")"],
  ))

  actions_enabled = true
  alarm_actions   = []
  ok_actions      = []

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-critical"
    Severity = "critical"
  })
}

resource "aws_cloudwatch_composite_alarm" "warning" {
  alarm_name        = "${var.name_prefix}-warning"
  alarm_description = "Any FSS warning condition. Reported by the daily alarm digest, never e-mailed on its own."

  alarm_rule = join(" OR ", [for name in local.warning_alarm_keys : "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")"])

  actions_enabled = true
  alarm_actions   = []
  ok_actions      = []

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-warning"
    Severity = "warning"
  })
}
