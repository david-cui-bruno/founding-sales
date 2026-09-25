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
# warning says so from outside the Mac, over the same fifteen minutes, and reaches the
# inbox through the warning roll-up only.
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
      && !contains(keys(aws_cloudwatch_composite_alarm.critical_condition), "mailbox_coverage_stale")
    )
    error_message = "The coverage warning reaches the inbox through the warning roll-up and nothing else."
  }
}

# Lane g81, audit O14. One OR composite in ALARM hides every later critical
# condition, so each critical condition has a composite of its own whose rule is
# that one alarm, and nothing else does.
run "every_critical_condition_has_a_composite_of_its_own" {
  command = plan

  assert {
    condition = length(aws_cloudwatch_composite_alarm.critical_condition) == length([
      for name, alarm in output.alarm_inventory : name if alarm.severity == "critical"
    ]) + 1
    error_message = "One composite per critical metric alarm, and one for all_sequences_held."
  }

  assert {
    condition = alltrue([
      for name, alarm in output.alarm_inventory :
      aws_cloudwatch_composite_alarm.critical_condition[name].alarm_rule == "ALARM(\"fss-test-${replace(name, "_", "-")}\")"
      && aws_cloudwatch_composite_alarm.critical_condition[name].alarm_name == "fss-test-critical-${replace(name, "_", "-")}"
      if alarm.severity == "critical"
    ])
    error_message = "Each critical condition's composite reads exactly its own alarm, so it trips whatever else is open."
  }

  assert {
    condition     = aws_cloudwatch_composite_alarm.critical_condition["all_sequences_held"].alarm_rule == "ALARM(\"fss-test-all-sequences-held\")"
    error_message = "The metric-math alarm has a composite of its own too."
  }

  assert {
    condition = alltrue([
      for name, alarm in output.alarm_inventory :
      !contains(keys(aws_cloudwatch_composite_alarm.critical_condition), name)
      if alarm.severity == "warning"
    ])
    error_message = "A warning has no per-condition composite; the warning roll-up is its only e-mail."
  }
}

# The four conditions the worker's own metric loop publishes with missing data
# breaching trip whenever the worker stops publishing. Their e-mails wait while
# worker-heartbeat-missed is in ALARM; nothing else waits on anything.
run "a_dead_worker_is_one_e_mail_not_five" {
  command = plan

  assert {
    condition = sort([
      for name, composite in aws_cloudwatch_composite_alarm.critical_condition : name
      if length(composite.actions_suppressor) > 0
    ]) == tolist(["api_heartbeat_missed", "canary_stale", "mailbox_heartbeat_missed", "scheduler_heartbeat_missed"])
    error_message = "Exactly the API, scheduler and mailbox heartbeats and the canary are held back while the worker is down."
  }

  assert {
    condition = alltrue(flatten([
      for composite in aws_cloudwatch_composite_alarm.critical_condition : [
        for suppressor in composite.actions_suppressor :
        suppressor.alarm == "fss-test-worker-heartbeat-missed" && suppressor.wait_period == 120 && suppressor.extension_period == 300
      ]
    ]))
    error_message = "The suppressor is the worker's heartbeat alarm, with a two-minute wait and a five-minute extension."
  }

  assert {
    condition = alltrue([
      for name in ["worker_heartbeat_missed", "suppression_journal_failure", "restore_generation_mismatch", "outbound_invariant_failure", "all_sequences_held"] :
      length(aws_cloudwatch_composite_alarm.critical_condition[name].actions_suppressor) == 0
    ])
    error_message = "The worker's own alarm and the safety conditions are never held back."
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
    condition = (
      aws_cloudwatch_composite_alarm.warning.actions_enabled
      && aws_cloudwatch_composite_alarm.warning.alarm_actions == toset([aws_sns_topic.alerts.arn])
      && aws_cloudwatch_composite_alarm.warning.ok_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The warning composite notifies the alert topic, and only it, on ALARM and on OK."
  }

  # Lane g81: the critical roll-up sends the all-clear only, and each critical
  # condition's own composite sends its ALARM only, so one incident is still one
  # e-mail in and one out and a second incident is one more in.
  assert {
    condition = (
      aws_cloudwatch_composite_alarm.critical.actions_enabled
      && length(aws_cloudwatch_composite_alarm.critical.alarm_actions) == 0
      && aws_cloudwatch_composite_alarm.critical.ok_actions == toset([aws_sns_topic.alerts.arn])
    )
    error_message = "The critical roll-up e-mails the topic once, when every critical condition is clear."
  }

  assert {
    condition = length(aws_cloudwatch_composite_alarm.critical_condition) > 0 && alltrue([
      for composite in aws_cloudwatch_composite_alarm.critical_condition :
      composite.actions_enabled
      && composite.alarm_actions == toset([aws_sns_topic.alerts.arn])
      && length(composite.ok_actions) == 0
      && try(length(composite.insufficient_data_actions), 0) == 0
    ])
    error_message = "Each critical condition's composite e-mails the alert topic, and only it, when it trips."
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
# alarm nobody hears. So every one is named by exactly one roll-up, the one its
# severity says, and the roll-ups name nothing else. (A critical one is also named
# by its own per-condition composite; that run is above.)
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
