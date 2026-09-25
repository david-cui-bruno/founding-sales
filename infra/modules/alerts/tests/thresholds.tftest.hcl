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
      && output.alarm_inventory[name].evaluation_periods == 1
      && output.alarm_inventory[name].datapoints_to_alarm == 1
      && output.alarm_inventory[name].severity == "critical"
    ])
    error_message = "Journal failure, restore-generation mismatch and outbound invariant failure are immediately critical."
  }
}

# An apply run, because the routing assertions are about the topic ARN, and an
# ARN is a value only the apply knows. Mocked providers make the apply offline:
# no credential, no call, and the values are the mock defaults above. Asserting
# them during a plan would need `override_during = plan`, which is the setting
# that hid the rehearsal's error.
#
# Lane g62: only the composites notify. Until then every metric alarm notified
# the topic on ALARM and OK beside its composite, and one flap on 24 September
# 2026 sent four to six e-mails. The metric alarms now carry no action at all.
run "criticals_roll_up_into_one_composite_that_notifies_the_topic" {
  command = apply

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

  assert {
    condition = alltrue([
      for composite in [aws_cloudwatch_composite_alarm.critical, aws_cloudwatch_composite_alarm.warning] :
      composite.actions_enabled
      && composite.alarm_actions == toset([aws_sns_topic.alerts.arn])
      && composite.ok_actions == toset([aws_sns_topic.alerts.arn])
    ])
    error_message = "Both composites notify the alert topic, and only it, on ALARM and on OK."
  }

  assert {
    condition = alltrue([
      for alarm in concat(values(aws_cloudwatch_metric_alarm.this), [aws_cloudwatch_metric_alarm.all_sequences_held]) :
      length(alarm.alarm_actions) == 0
      && length(alarm.ok_actions) == 0
      && try(length(alarm.insufficient_data_actions), 0) == 0
    ])
    error_message = "No metric alarm notifies anything: the composite it belongs to is the one e-mail per incident."
  }

  # The floor under the assertion above: it must have read every metric alarm.
  assert {
    condition     = length(concat(values(aws_cloudwatch_metric_alarm.this), [aws_cloudwatch_metric_alarm.all_sequences_held])) == length(output.alarm_inventory) + 1
    error_message = "The routing assertions must cover the whole inventory and the metric-math alarm."
  }
}

# A metric alarm that sends nothing and belongs to no composite would be an
# alarm nobody hears. So every one is named by exactly one composite, the one
# its severity says, and the composites name nothing else.
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
    error_message = "Alerts are delivered by the AWS-native SNS email path, never through a connected salesperson mailbox."
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
