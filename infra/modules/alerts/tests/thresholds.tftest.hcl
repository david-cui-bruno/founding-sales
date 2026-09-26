# Mocked attributes stay unknown for the whole plan phase, as a real provider's
# are. Nothing below may compare one; the plan runs read declared arguments.
# The threshold values themselves are literals in main.tf's alarm map (spec 13.3);
# canary_stale and mailbox_coverage_stale are compared with the code by
# test/ops/terraformCrossChecks.check.ts.
mock_provider "aws" {
  override_during = apply

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:fss-test-alerts"
    }
  }

  # The digest (digest.tf) is applied by the apply run below too, and the provider
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
  # The stack passes the observability module's log key (David, 20 September 2026).
  kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
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
        "outbound_invariant_failure",
      ] : contains(keys(aws_cloudwatch_metric_alarm.this), required)
    ])
    error_message = "Every threshold section 13.3 names must have an alarm behind it."
  }
}

run "the_two_immediately_critical_conditions_alarm_on_one_datapoint" {
  command = plan

  assert {
    condition = alltrue([
      for name in ["suppression_journal_failure", "outbound_invariant_failure"] :
      aws_cloudwatch_metric_alarm.this[name].threshold == 1
      && aws_cloudwatch_metric_alarm.this[name].evaluation_periods == 1
      && aws_cloudwatch_metric_alarm.this[name].datapoints_to_alarm == 1
      && strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"${aws_cloudwatch_metric_alarm.this[name].alarm_name}\")")
    ])
    error_message = "Journal failure and outbound invariant failure are immediately critical: one datapoint of one line, judged one minute at a time, trips each."
  }
}

# Lane g81, audit O15. No connected mailbox is not a watch about to lapse: the gauge
# is absent then, and 0 for a connected mailbox with no live watch. The heartbeats
# and the canary still breach on missing data, which is what catches a worker that
# stopped publishing.
run "no_connected_mailbox_is_not_a_critical_watch" {
  command = plan

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.this["gmail_watch_expiring"].treat_missing_data == "notBreaching"
      && alltrue([
        for name in ["api_heartbeat_missed", "scheduler_heartbeat_missed", "worker_heartbeat_missed", "mailbox_heartbeat_missed", "canary_stale"] :
        aws_cloudwatch_metric_alarm.this[name].treat_missing_data == "breaching"
      ])
    )
    error_message = "No connected mailbox must not hold a critical watch alarm; the heartbeats and the canary still treat a missing datapoint as a failure."
  }
}

# Lane g99: nothing e-mails when it trips, so what is left of the routing is
# membership. A metric alarm that belongs to no composite would be an alarm no
# roll-up reports, so every one is named by exactly one roll-up and the roll-ups
# name nothing else. The absence of every action is tests/digest.tftest.hcl's.
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
    condition = (
      strcontains(aws_cloudwatch_composite_alarm.critical.alarm_rule, "ALARM(\"fss-test-all-sequences-held\")")
      && !strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "fss-test-all-sequences-held")
      && strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "ALARM(\"fss-test-oldest-runnable-job-warning\")")
      && strcontains(aws_cloudwatch_composite_alarm.warning.alarm_rule, "ALARM(\"fss-test-mailbox-coverage-stale\")")
    )
    error_message = "The metric-math alarm is a member of the critical composite only; a warning, such as the stale coverage watermark, raises the warning roll-up."
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
    condition     = length(aws_sns_topic_subscription.email) == 1 && alltrue([for subscription in aws_sns_topic_subscription.email : subscription.protocol == "email"])
    error_message = "The daily digest is delivered by the AWS-native SNS email path, never through a connected salesperson mailbox."
  }

  assert {
    condition     = aws_sns_topic.alerts.kms_master_key_id == var.kms_key_arn
    error_message = "The topic is encrypted with the customer key it was given, because CloudWatch cannot publish through the AWS-managed SNS key."
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
}

run "the_bare_fss_namespace_is_refused" {
  command = plan

  variables {
    metric_namespace = "FSS"
  }

  expect_failures = [var.metric_namespace]
}
