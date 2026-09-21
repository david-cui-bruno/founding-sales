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
  name_prefix    = "fss-test"
  aws_account_id = "123456789012"
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

# An apply run, because two of these assertions are about the topic ARN, and an
# ARN is a value only the apply knows. Mocked providers make the apply offline:
# no credential, no call, and the values are the mock defaults above. Asserting
# them during a plan would need `override_during = plan`, which is the setting
# that hid the rehearsal's error.
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
    condition     = contains(aws_cloudwatch_composite_alarm.critical.alarm_actions, aws_sns_topic.alerts.arn)
    error_message = "The composite must notify the alert topic."
  }

  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.this : contains(alarm.alarm_actions, aws_sns_topic.alerts.arn)
    ])
    error_message = "Every alarm notifies the alert topic."
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
