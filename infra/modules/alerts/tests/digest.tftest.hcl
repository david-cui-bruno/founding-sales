# Lane g99, the owner's decision 11C of 25 September 2026: one daily digest e-mail,
# nothing immediate.
#
# Offline: the AWS provider is mocked and the archive provider is the real one, which
# only zips the two source files under infra/lambdas/alarm-digest. The ARNs are the
# AWS documentation example values. Mocked values are supplied during the apply phase
# only (`override_during = apply`, as in the other files here), so the runs that
# compare ARNs are apply runs and the ones over declared arguments are plans.
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

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/fss/fss-test/alarm-digest"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-east-1:123456789012:function:fss-test-alarm-digest"
    }
  }
}

# Two roles, two ARNs, so "the schedule assumes its own role" cannot pass by both
# roles sharing one mocked value.
override_resource {
  target = aws_iam_role.digest
  values = {
    arn = "arn:aws:iam::123456789012:role/fss-test-alarm-digest"
    id  = "fss-test-alarm-digest"
  }
}

override_resource {
  target = aws_iam_role.digest_schedule
  values = {
    arn = "arn:aws:iam::123456789012:role/fss-test-alarm-digest-schedule"
    id  = "fss-test-alarm-digest-schedule"
  }
}

variables {
  name_prefix      = "fss-test"
  aws_account_id   = "123456789012"
  metric_namespace = "FSS/test"
  # Generated at test time, never a real address.
  alert_emails = ["alerts@example.invalid"]
}

# Nothing e-mails when it trips: no metric alarm and no composite has an alarm, OK or
# insufficient-data action of any kind, the topic included.
run "no_alarm_has_an_action" {
  command = plan

  assert {
    condition = alltrue([
      for alarm in concat(values(aws_cloudwatch_metric_alarm.this), [aws_cloudwatch_metric_alarm.all_sequences_held]) :
      length(alarm.alarm_actions) == 0
      && length(alarm.ok_actions) == 0
      && try(length(alarm.insufficient_data_actions), 0) == 0
    ])
    error_message = "A metric alarm carries an action. Since lane g99 the daily digest is the only e-mail."
  }

  assert {
    condition = alltrue([
      for composite in concat(
        [aws_cloudwatch_composite_alarm.critical, aws_cloudwatch_composite_alarm.warning],
        values(aws_cloudwatch_composite_alarm.critical_condition),
      ) :
      length(composite.alarm_actions) == 0
      && length(composite.ok_actions) == 0
      && try(length(composite.insufficient_data_actions), 0) == 0
    ])
    error_message = "A composite carries an action. Neither roll-up nor any per-condition composite may e-mail; the digest reports them."
  }

  # The floor under the two assertions above: they read every alarm there is.
  assert {
    condition = (
      length(concat(values(aws_cloudwatch_metric_alarm.this), [aws_cloudwatch_metric_alarm.all_sequences_held])) == length(output.alarm_inventory) + 1
      && length(aws_cloudwatch_composite_alarm.critical_condition) > 10
    )
    error_message = "The action assertions must cover the whole inventory, the metric-math alarm and every per-condition composite."
  }
}

run "the_digest_runs_at_seven_in_new_york_every_day" {
  command = plan

  assert {
    condition = (
      aws_scheduler_schedule.digest.schedule_expression == "cron(0 7 * * ? *)"
      && aws_scheduler_schedule.digest.schedule_expression_timezone == "America/New_York"
    )
    error_message = "The digest runs at 07:00 every day, evaluated in America/New_York so it does not move at the daylight-saving changes."
  }

  assert {
    condition = (
      aws_scheduler_schedule.digest.state == "ENABLED"
      && aws_scheduler_schedule.digest.flexible_time_window[0].mode == "OFF"
      && aws_scheduler_schedule.digest.group_name == "default"
      && aws_scheduler_schedule.digest.name == "fss-test-alarm-digest"
    )
    error_message = "The schedule is enabled, fires on the minute, and is named from the prefix in the default group."
  }

  assert {
    condition     = output.digest_schedule == { name = "fss-test-alarm-digest", expression = "cron(0 7 * * ? *)", time_zone = "America/New_York" }
    error_message = "The module reports the schedule it declared."
  }
}

run "the_digest_function_is_small_and_writes_its_own_log_group" {
  command = plan

  assert {
    condition = (
      aws_lambda_function.digest.function_name == "fss-test-alarm-digest"
      && aws_lambda_function.digest.handler == "index.handler"
      && startswith(aws_lambda_function.digest.runtime, "nodejs")
      && aws_lambda_function.digest.timeout == 60
    )
    error_message = "One Node.js function, named from the prefix, whose handler is index.handler."
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.digest.name == "/fss/fss-test/alarm-digest"
      && aws_cloudwatch_log_group.digest.retention_in_days == 14
      && aws_lambda_function.digest.logging_config[0].log_group == "/fss/fss-test/alarm-digest"
    )
    error_message = "The function logs to its own group under /fss/<prefix>, kept fourteen days."
  }

  assert {
    condition = (
      aws_lambda_function.digest.environment[0].variables["FSS_ALARM_PREFIX"] == "fss-test-"
      && aws_lambda_function.digest.environment[0].variables["FSS_DIGEST_TIME_ZONE"] == "America/New_York"
    )
    error_message = "The function reads this environment's alarms, by the prefix and its hyphen, and writes New York times."
  }

  assert {
    condition     = length(data.archive_file.digest.output_base64sha256) > 0 && aws_lambda_function.digest.source_code_hash == data.archive_file.digest.output_base64sha256
    error_message = "The code is the zip Terraform built from infra/lambdas/alarm-digest, and a change to it is a change to the function."
  }

  assert {
    condition     = alltrue([for name in output.digest_resource_names : startswith(name, "fss-test-") || startswith(name, "/fss/fss-test/")])
    error_message = "Every name the digest claims carries the environment prefix."
  }
}

run "the_digest_role_holds_exactly_what_the_digest_does" {
  command = apply

  assert {
    condition = sort(flatten([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement : statement.Action
      ])) == tolist([
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "sns:Publish",
    ])
    error_message = "The digest role reads alarms and their history, publishes, encrypts for the topic and writes its log group, and nothing else."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement :
      statement.Effect == "Allow"
      && (statement.Resource != "*" || sort(statement.Action) == tolist(["cloudwatch:DescribeAlarmHistory", "cloudwatch:DescribeAlarms"]))
    ])
    error_message = "Only the two read-only Describe actions are on every resource."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement :
      contains(statement.Action, "sns:Publish") ? statement.Resource == aws_sns_topic.alerts.arn && length(statement.Action) == 1 : true
    ])
    error_message = "The digest publishes to the alert topic alone."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement :
      contains(statement.Action, "kms:GenerateDataKey") ? statement.Resource == aws_kms_key.alerts[0].arn : true
    ])
    error_message = "The digest may use the topic's key and no other."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement :
      contains(statement.Action, "logs:PutLogEvents") ? statement.Resource == "${aws_cloudwatch_log_group.digest.arn}:*" : true
    ])
    error_message = "The digest writes its own log group's streams and nothing else."
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.digest.assume_role_policy).Statement) == 1
      && jsondecode(aws_iam_role.digest.assume_role_policy).Statement[0].Principal == { Service = "lambda.amazonaws.com" }
      && aws_iam_role_policy.digest.role == aws_iam_role.digest.id
      && aws_lambda_function.digest.role == aws_iam_role.digest.arn
    )
    error_message = "Only Lambda assumes the digest role, and the function runs as it."
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.digest_schedule.policy).Statement[0].Action == ["lambda:InvokeFunction"]
      && jsondecode(aws_iam_role_policy.digest_schedule.policy).Statement[0].Resource == aws_lambda_function.digest.arn
      && length(jsondecode(aws_iam_role_policy.digest_schedule.policy).Statement) == 1
      && jsondecode(aws_iam_role.digest_schedule.assume_role_policy).Statement[0].Principal == { Service = "scheduler.amazonaws.com" }
      && jsondecode(aws_iam_role.digest_schedule.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    )
    error_message = "The schedule's role is Scheduler's, in this account only, and may invoke the digest function and nothing else."
  }
}

run "the_digest_publishes_to_the_existing_alert_topic" {
  command = apply

  assert {
    condition = (
      aws_lambda_function.digest.environment[0].variables["FSS_ALERT_TOPIC_ARN"] == aws_sns_topic.alerts.arn
      && aws_sns_topic.alerts.arn == "arn:aws:sns:us-east-1:123456789012:fss-test-alerts"
      && output.topic_arn == aws_sns_topic.alerts.arn
    )
    error_message = "The digest publishes to the alert topic this module already had, the one the e-mail subscriptions are on."
  }

  assert {
    condition     = alltrue([for subscription in aws_sns_topic_subscription.email : subscription.topic_arn == aws_sns_topic.alerts.arn])
    error_message = "The subscriptions stay on that topic, so the digest reaches alert_emails."
  }

  assert {
    condition = (
      aws_scheduler_schedule.digest.target[0].arn == aws_lambda_function.digest.arn
      && aws_scheduler_schedule.digest.target[0].role_arn == aws_iam_role.digest_schedule.arn
      && aws_iam_role.digest_schedule.arn != aws_iam_role.digest.arn
    )
    error_message = "The schedule invokes the digest function, as its own role rather than the function's."
  }
}

# Logs and alerts share one key in the stack (David, 20 September 2026). Given a key,
# the digest's KMS grant names that key.
run "with_a_shared_key_the_digest_uses_that_key" {
  command = apply

  variables {
    create_kms_key = false
    kms_key_arn    = "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
  }

  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.digest.policy).Statement :
      contains(statement.Action, "kms:GenerateDataKey") && statement.Resource == "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    ])
    error_message = "The digest's KMS grant is the key the topic is encrypted with."
  }
}
