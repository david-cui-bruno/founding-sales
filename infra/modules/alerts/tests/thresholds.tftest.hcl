# Mocked attributes stay unknown for the whole plan phase, as a real provider's
# are. Nothing below may compare one; the assertions are over declared
# arguments, module outputs and the alarm inventory.
mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:fss-test-alerts"
    }
  }

  # The digest (digest.tf) is applied by the apply runs below too, and the provider
  # refuses a function role or a schedule target that is not an ARN.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/fss-test-alarm-digest"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:fss-test-alarm-digest"
    }
  }
}

variables {
  name_prefix      = "fss-test"
  aws_account_id   = "123456789012"
  metric_namespace = "FSS/test"
  # Generated at test time, never a real address.
  alert_emails = ["alerts@example.invalid"]
}

run "every_threshold_in_the_spec_has_an_alarm" {
  command = plan

  assert {
    condition = alltrue([
      for required in [
        "today_snapshot_absent",
        "scheduler_heartbeat_missed",
        "mailbox_heartbeat_missed",
        "oldest_runnable_job_warning",
        "oldest_runnable_job_critical",
        "gmail_watch_expiring",
        "canary_stale",
        "dead_job_unresolved",
        "mailbox_disconnected",
        "suppression_journal_failure",
        "restore_generation_mismatch",
        "outbound_invariant_failure",
      ] : contains(keys(output.alarm_inventory), required)
    ])
    error_message = "Every threshold section 13.3 names must have an alarm behind it."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.this) == length(output.alarm_inventory)
    error_message = "Every metric alarm resource must come from the declared inventory."
  }
}

run "the_spec_values_are_the_defaults" {
  command = plan

  assert {
    condition     = output.alarm_inventory["scheduler_heartbeat_missed"].evaluation_periods == 3 && output.alarm_inventory["scheduler_heartbeat_missed"].period == 60
    error_message = "Three missed one-minute scheduler checks."
  }

  assert {
    condition     = output.alarm_inventory["oldest_runnable_job_warning"].threshold == 300 && output.alarm_inventory["oldest_runnable_job_critical"].threshold == 900
    error_message = "Oldest runnable job warns at five minutes and is critical at fifteen."
  }

  # Lane g86, audit O18: the age is the target, so the first sample above it alarms.
  assert {
    condition = alltrue([
      for name in ["oldest_runnable_job_warning", "oldest_runnable_job_critical"] :
      output.alarm_inventory[name].period == 60 && output.alarm_inventory[name].evaluation_periods == 1 && output.alarm_inventory[name].datapoints_to_alarm == 1
    ])
    error_message = "A job-age alarm fires on the first one-minute maximum above its threshold; five of five made the five-minute warning fire at about ten."
  }

  assert {
    condition     = output.alarm_inventory["gmail_watch_expiring"].threshold == 48
    error_message = "Gmail watch alarms within two days of expiry."
  }

  assert {
    condition     = output.alarm_inventory["canary_stale"].threshold == 300
    error_message = "The canary must complete within five minutes."
  }

  assert {
    condition     = output.alarm_inventory["dead_job_unresolved"].threshold == 3600
    error_message = "A dead job may be unresolved for one hour."
  }

  assert {
    condition     = output.alarm_inventory["mailbox_disconnected"].threshold == 48
    error_message = "A recently sending mailbox may be disconnected for 48 hours."
  }
}

run "the_three_immediately_critical_conditions_alarm_on_one_datapoint" {
  command = plan

  assert {
    condition = alltrue([
      for name in ["suppression_journal_failure", "restore_generation_mismatch", "outbound_invariant_failure"] :
      output.alarm_inventory[name].threshold == 1
      && output.alarm_inventory[name].datapoints_to_alarm == 1
      && output.alarm_inventory[name].severity == "critical"
    ])
    error_message = "Journal failure, restore-generation mismatch and outbound invariant failure are immediately critical: one datapoint of one line trips each."
  }

  assert {
    condition = alltrue([
      for name in ["suppression_journal_failure", "outbound_invariant_failure"] :
      output.alarm_inventory[name].evaluation_periods == 1
    ])
    error_message = "The journal failure and the invariant failure are events, judged one minute at a time."
  }
}

# Lane g81, audit O16. The mismatch is a condition, and the worker logs it on every
# metric pass while it lasts; the alarm clears only after three quiet minutes, so the
# one minute in many hundreds that a fixed-delay pass skips does not read OK.
run "the_restore_mismatch_alarm_holds_while_the_mismatch_lasts" {
  command = plan

  assert {
    condition = (
      output.alarm_inventory["restore_generation_mismatch"].evaluation_periods == 3
      && output.alarm_inventory["restore_generation_mismatch"].datapoints_to_alarm == 1
      && output.alarm_inventory["restore_generation_mismatch"].period == 60
      && output.alarm_inventory["restore_generation_mismatch"].treat_missing_data == "notBreaching"
    )
    error_message = "One line in three minutes holds the restore-generation alarm in ALARM, and three quiet minutes clear it."
  }
}

# Lane g81, audit O15. No connected mailbox is not a watch about to lapse: the gauge
# is absent then, and 0 for a connected mailbox with no live watch. The heartbeats
# and the canary still breach on missing data, which is what catches a worker that
# stopped publishing.
run "no_connected_mailbox_is_not_a_critical_watch" {
  command = plan

  assert {
    condition     = output.alarm_inventory["gmail_watch_expiring"].treat_missing_data == "notBreaching"
    error_message = "An environment with no connected mailbox must not sit in critical ALARM over a watch it does not have."
  }

  assert {
    condition = alltrue([
      for name in ["api_heartbeat_missed", "scheduler_heartbeat_missed", "worker_heartbeat_missed", "mailbox_heartbeat_missed", "canary_stale"] :
      output.alarm_inventory[name].treat_missing_data == "breaching"
    ])
    error_message = "The heartbeats and the canary still treat a missing datapoint as a failure."
  }
}

# Lane g81. The send path holds an owner's automated email once their mailbox's
# coverage watermark is fifteen minutes old (packages/domain/mail/coverage.ts). This
# warning says so from outside the Mac, over the same fifteen minutes, and belongs to
# the warning roll-up only; the daily digest reports it (lane g99).
run "a_stale_coverage_watermark_is_a_warning" {
  command = plan

  assert {
    condition = (
      output.alarm_inventory["mailbox_coverage_stale"].metric_name == "MailboxCoverageAgeSeconds"
      && output.alarm_inventory["mailbox_coverage_stale"].threshold == 900
      && output.alarm_inventory["mailbox_coverage_stale"].comparison == "GreaterThanThreshold"
      && output.alarm_inventory["mailbox_coverage_stale"].period == 60
      && output.alarm_inventory["mailbox_coverage_stale"].evaluation_periods == 3
      && output.alarm_inventory["mailbox_coverage_stale"].datapoints_to_alarm == 3
      && output.alarm_inventory["mailbox_coverage_stale"].treat_missing_data == "notBreaching"
      && output.alarm_inventory["mailbox_coverage_stale"].severity == "warning"
    )
    error_message = "Coverage older than fifteen minutes for three consecutive minutes is a warning; no connected, ready mailbox is no datapoint and not a breach."
  }

  assert {
    condition = (
      strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "ALARM(\"fss-test-mailbox-coverage-stale\")")
      && !strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "fss-test-mailbox-coverage-stale")
    )
    error_message = "The coverage warning belongs to the warning roll-up and nothing else."
  }
}

# Lane g99: nothing e-mails when it trips, so what is left of the routing is
# membership. The absence of every action, on every metric alarm and every
# composite, is tests/digest.tftest.hcl's, beside the digest that replaced them.
run "criticals_roll_up_into_one_composite" {
  command = plan

  assert {
    condition     = strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"fss-test-suppression-journal-failure\")")
    error_message = "The critical composite must include the journal failure alarm."
  }

  assert {
    condition     = strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"fss-test-all-sequences-held\")")
    error_message = "The critical composite must include the all-sequences-held alarm."
  }

  assert {
    condition     = strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "fss-test-oldest-runnable-job-warning") == false
    error_message = "A warning must not raise the critical composite."
  }
}

# A metric alarm that belongs to no composite would be an alarm no roll-up
# reports. So every one is named by exactly one roll-up, the one its
# severity says, and the roll-ups name nothing else.
run "every_metric_alarm_feeds_exactly_one_composite" {
  command = plan

  assert {
    condition = alltrue([
      for name, alarm in aws_cloudwatch_metric_alarm.this :
      (strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"${alarm.alarm_name}\")") ? 1 : 0)
      + (strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "ALARM(\"${alarm.alarm_name}\")") ? 1 : 0)
      == 1
    ])
    error_message = "Every metric alarm is a member of exactly one composite."
  }

  assert {
    condition = alltrue([
      for name, alarm in aws_cloudwatch_metric_alarm.this :
      strcontains(
        output.alarm_inventory[name].severity == "critical" ? aws_cloudwatch_composite_alarm.critical.alarm_rule : aws_cloudwatch_composite_alarm.warning.alarm_rule,
        "ALARM(\"${alarm.alarm_name}\")",
      )
    ])
    error_message = "A critical alarm is a member of the critical composite, a warning of the warning composite."
  }

  assert {
    condition = (
      strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"fss-test-all-sequences-held\")")
      && !strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "fss-test-all-sequences-held")
    )
    error_message = "The metric-math alarm is a member of the critical composite only."
  }

  assert {
    condition = (
      length(regexall("ALARM\\(", aws_cloudwatch_composite_alarm.critical.alarm_rule))
      + length(regexall("ALARM\\(", aws_cloudwatch_composite_alarm.warning.alarm_rule))
      == length(aws_cloudwatch_metric_alarm.this) + 1
    )
    error_message = "The composites name every metric alarm once and nothing else."
  }
}

run "delivery_does_not_depend_on_a_gmail_grant" {
  command = apply

  assert {
    condition     = alltrue([for subscription in aws_sns_topic_subscription.email : subscription.protocol == "email"])
    error_message = "The daily digest is delivered by the AWS-native SNS email path, never through a connected salesperson mailbox."
  }

  assert {
    condition     = length(aws_sns_topic_subscription.email) == length(output.subscription_endpoints)
    error_message = "One subscription per configured recipient."
  }

  assert {
    condition     = output.created_own_kms_key && aws_sns_topic.alerts.kms_master_key_id == aws_kms_key.alerts[0].arn
    error_message = "The topic is encrypted with a customer key, because CloudWatch cannot publish through the AWS-managed SNS key."
  }

  assert {
    condition     = aws_kms_key.alerts[0].enable_key_rotation && length(aws_kms_alias.alerts) == 1
    error_message = "The key it creates rotates and carries an alias an operator can read in the console."
  }
}

run "a_recipient_that_is_not_an_address_is_refused" {
  command = plan

  variables {
    alert_emails = ["not an address"]
  }

  expect_failures = [var.alert_emails]
}

# g42, lane g55: every alarm reads the namespace it was given, and only that one.
# The value is the stack's FSS/<name_prefix>; the bare FSS every environment in the
# account used to share is refused at the variable, so a rehearsal's alarms can no
# longer read production's metrics or the other way round.
run "every_alarm_reads_the_namespace_it_was_given_and_no_other" {
  command = plan

  assert {
    condition = length(aws_cloudwatch_metric_alarm.this) > 0 && alltrue([
      for alarm in aws_cloudwatch_metric_alarm.this : alarm.namespace == "FSS/test"
    ])
    error_message = "Every single-metric alarm reads the environment's namespace."
  }

  # The metric-math alarm has three queries: the expression and the two metrics
  # it divides. Both metrics must be read from the same namespace, or the ratio
  # compares one environment's held enrollments with another's active ones.
  assert {
    condition = sort(flatten([
      for query in aws_cloudwatch_metric_alarm.all_sequences_held.metric_query :
      [for metric in query.metric : metric.namespace]
    ])) == tolist(["FSS/test", "FSS/test"])
    error_message = "Both metrics behind all_sequences_held are read from the environment's namespace."
  }

  assert {
    condition     = output.alarm_metric_namespaces == tolist(["FSS/test"])
    error_message = "The module reports exactly one namespace across all its alarms."
  }
}

run "the_bare_fss_namespace_is_refused" {
  command = plan

  variables {
    metric_namespace = "FSS"
  }

  expect_failures = [var.metric_namespace]
}
