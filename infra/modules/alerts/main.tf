# FSS greenfield alerting.
#
# Every threshold in spec 13.3 becomes one CloudWatch alarm over a metric the
# applications emit, and the criticals roll up into one composite alarm so the
# operator gets one notification for one incident rather than nine.
#
# Only composites notify (lane g62). Until then every metric alarm notified the
# topic on ALARM and on OK beside the composite, so one incident sent the
# composite's two e-mails plus two for every member it tripped: four to six
# e-mails per flap on 24 September 2026. The metric alarms keep their state,
# which is what the composites read, and send nothing themselves. Every metric
# alarm is a member of exactly one roll-up: severity "critical" and
# all_sequences_held in <prefix>-critical, severity "warning" in
# <prefix>-warning. tests/thresholds.tftest.hcl holds both halves.
#
# One incident, one e-mail — and a second incident, a second e-mail (lane g81,
# audit O14). A composite in ALARM does not transition when another member
# trips, so with one OR composite the first critical condition hid every later
# one until all of them had cleared. So each critical condition also has a
# composite of its own, <prefix>-critical-<condition>, whose rule is that one
# alarm: it e-mails when its condition enters ALARM, whatever else is already
# open. <prefix>-critical keeps the roll-up and sends the one OK, when every
# critical condition is clear. A single incident is still two e-mails; each
# further condition that trips while it is open is one more.
#
# The four conditions the worker's own metric loop publishes and that treat
# missing data as breaching — the API, scheduler and mailbox heartbeats and the
# canary — go to ALARM whenever the worker stops publishing, whatever their own
# state. While worker-heartbeat-missed is in ALARM their composites' e-mails are
# held back (CloudWatch actions suppression); if one is still in ALARM five
# minutes after the worker recovers it e-mails then. A dead worker is one
# e-mail, not five. docs/decisions/g81-one-e-mail-per-critical-condition.md.
#
# Which members are in ALARM now is
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
      description         = "A mailbox that sent in the last 30 days has been disconnected for 48 hours."
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

  # The worker's metric loop publishes every metric above that is not log-derived,
  # so a critical alarm that treats missing data as breaching trips whenever that
  # loop stops, whatever its own condition is doing. Those are the ones held back
  # while worker-heartbeat-missed, which is the loop stopping, is in ALARM.
  worker_published_breaching_keys = sort([
    for name, alarm in local.alarms : name
    if alarm.severity == "critical" && alarm.treat_missing_data == "breaching" && name != "worker_heartbeat_missed"
  ])

  # How long a held-back composite waits for the worker alarm to trip (the two
  # evaluate the same missing minutes, so within one or two of each other), and how
  # long after the worker recovers it waits for its own condition to clear before
  # it e-mails what is still true.
  worker_suppression_wait_seconds      = 120
  worker_suppression_extension_seconds = 300

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

# Only composites notify the topic. The two roll-ups name every metric alarm
# above exactly once between them; each critical condition also has a composite
# of its own below.
#
# <prefix>-critical sends the all-clear and nothing else (lane g81): its ALARM is
# the per-condition composites' to announce, one e-mail each, and its OK is the
# one moment the roll-up knows something they do not — that every critical
# condition is clear.
resource "aws_cloudwatch_composite_alarm" "critical" {
  alarm_name        = "${var.name_prefix}-critical"
  alarm_description = "Every immediately critical FSS condition. E-mails once, when all of them are clear; each condition's own composite e-mails when it trips."

  alarm_rule = join(" OR ", concat(
    [for name in local.critical_alarm_keys : "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")"],
    ["ALARM(\"${aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name}\")"],
  ))

  actions_enabled = true
  alarm_actions   = []
  ok_actions      = [aws_sns_topic.alerts.arn]

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-critical"
    Severity = "critical"
  })
}

# One composite per critical condition (lane g81, audit O14). Its rule is the one
# alarm, so it enters ALARM when that condition does, even while another critical
# condition already holds <prefix>-critical in ALARM, and e-mails the topic then.
# It sends no OK: the all-clear is <prefix>-critical's, so a single incident is
# still one e-mail in and one out.
locals {
  critical_condition_alarms = merge(
    { for name in local.critical_alarm_keys : name => aws_cloudwatch_metric_alarm.this[name].alarm_name },
    { all_sequences_held = aws_cloudwatch_metric_alarm.all_sequences_held.alarm_name },
  )
}

resource "aws_cloudwatch_composite_alarm" "critical_condition" {
  for_each = local.critical_condition_alarms

  alarm_name        = "${var.name_prefix}-critical-${replace(each.key, "_", "-")}"
  alarm_description = "One immediately critical FSS condition: ${each.value}. E-mails when it trips, even while another critical condition is open."
  alarm_rule        = "ALARM(\"${each.value}\")"

  actions_enabled = true
  alarm_actions   = [aws_sns_topic.alerts.arn]
  ok_actions      = []

  # Held back while the worker's own heartbeat alarm is in ALARM, for the four
  # conditions that trip merely because the worker stopped publishing (see the top
  # of this file). CloudWatch performs the action afterwards if the condition is
  # still in ALARM when the extension ends, so nothing true is lost.
  dynamic "actions_suppressor" {
    for_each = contains(local.worker_published_breaching_keys, each.key) ? [aws_cloudwatch_metric_alarm.this["worker_heartbeat_missed"].alarm_name] : []

    content {
      alarm            = actions_suppressor.value
      wait_period      = local.worker_suppression_wait_seconds
      extension_period = local.worker_suppression_extension_seconds
    }
  }

  tags = merge(var.tags, {
    Name     = "${var.name_prefix}-critical-${replace(each.key, "_", "-")}"
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
