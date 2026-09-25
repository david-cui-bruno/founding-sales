mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }
}

variables {
  name_prefix      = "fss-test"
  aws_region       = "us-east-1"
  aws_account_id   = "123456789012"
  metric_namespace = "FSS/fss-test"
}

run "log_groups_are_namespaced_encrypted_and_kept_ninety_days" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_log_group.service) == 2
    error_message = "One log group per service."
  }

  assert {
    condition     = alltrue([for group in aws_cloudwatch_log_group.service : group.retention_in_days == 90])
    error_message = "The retention table says operational logs are kept 90 days."
  }

  assert {
    condition     = alltrue([for group in aws_cloudwatch_log_group.service : startswith(group.name, "/fss/fss-test/")])
    error_message = "Log group names carry the environment namespace."
  }
}

run "the_safety_metrics_the_alarms_need_exist" {
  command = plan

  assert {
    condition = alltrue([
      for required in ["SuppressionJournalWriteFailures", "RestoreGenerationMismatches", "OutboundSafetyInvariantFailures", "DeadJobs"] :
      contains(output.metric_names, required)
    ])
    error_message = "Every immediately critical alarm must have a metric filter behind it."
  }

  # Lane g81: the API and the worker both write the suppression journal and both log
  # its failure, so both log groups are filtered into the one metric.
  assert {
    condition = sort([
      for filter in aws_cloudwatch_log_metric_filter.this : filter.log_group_name
      if filter.metric_transformation[0].name == "SuppressionJournalWriteFailures"
    ]) == tolist(["/fss/fss-test/api", "/fss/fss-test/worker"])
    error_message = "A suppression journal write failure in either process reaches SuppressionJournalWriteFailures."
  }

  # Non-empty first: `alltrue` over no filters is true, and would pass a module
  # that had stopped creating them.
  assert {
    condition = length(aws_cloudwatch_log_metric_filter.this) > 0 && alltrue([
      for filter in aws_cloudwatch_log_metric_filter.this :
      filter.metric_transformation[0].namespace == "FSS/fss-test"
    ])
    error_message = "Every metric filter publishes into this environment's namespace, FSS/<name_prefix>, which is where its alarms look."
  }

  assert {
    condition     = output.metric_namespace == "FSS/fss-test"
    error_message = "The module reports the namespace its filters publish to."
  }
}

# The bare namespace is refused rather than defaulted (g42, lane g55). Every
# environment in the account used to publish there, so a rehearsal's log lines
# fed production's safety alarms.
run "the_bare_fss_namespace_is_refused" {
  command = plan

  variables {
    metric_namespace = "FSS"
  }

  expect_failures = [var.metric_namespace]
}

run "an_undocumented_retention_value_is_refused" {
  command = plan

  variables {
    retention_days = 45
  }

  expect_failures = [var.retention_days]
}

run "sharing_with_alerts_admits_cloudwatch_and_eventbridge_on_the_key" {
  command = plan

  variables {
    shared_with_alerts = true
  }

  assert {
    condition     = contains([for statement in jsondecode(aws_kms_key.logs.policy).Statement : statement.Sid], "CloudWatchAlarmsPublish")
    error_message = "A key shared with the alert topic must let cloudwatch.amazonaws.com and events.amazonaws.com use it."
  }
}

run "not_sharing_keeps_the_key_policy_to_logs" {
  command = plan

  assert {
    condition     = !contains([for statement in jsondecode(aws_kms_key.logs.policy).Statement : statement.Sid], "CloudWatchAlarmsPublish")
    error_message = "Without sharing, the log key must admit only CloudWatch Logs and the account."
  }
}

# The key each log group is attached to, asserted where the value exists.
#
# `aws_kms_key.logs.arn` is computed, and the mock above supplies mocked values
# during the apply phase, so this comparison cannot be made during a plan any
# more than a real one could. An apply run under a mocked provider reaches
# nothing and needs no credential.
# `docs/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "every_log_group_is_encrypted_with_the_module_s_own_key" {
  command = apply

  assert {
    condition     = alltrue([for group in aws_cloudwatch_log_group.service : group.kms_key_id == aws_kms_key.logs.arn])
    error_message = "Log groups are encrypted with the module's customer key."
  }
}

