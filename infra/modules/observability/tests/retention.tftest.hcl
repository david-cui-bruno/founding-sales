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

# Every filter feeds an immediately critical alarm. Lane g81: the API and the worker
# both write the suppression journal and both log its failure, so both groups are
# filtered into the one metric.
run "the_safety_metrics_the_alarms_need_come_from_both_writers" {
  command = plan

  assert {
    condition = sort([
      for filter in aws_cloudwatch_log_metric_filter.this :
      "${filter.metric_transformation[0].name} ${filter.log_group_name}"
      ]) == tolist([
      "OutboundSafetyInvariantFailures /fss/fss-test/worker",
      "SuppressionJournalWriteFailures /fss/fss-test/api",
      "SuppressionJournalWriteFailures /fss/fss-test/worker",
    ])
    error_message = "A journal write failure in either process, and an outbound invariant failure in the worker, each reach the metric its alarm reads."
  }

  assert {
    condition = length(aws_cloudwatch_log_metric_filter.this) > 0 && alltrue([
      for filter in aws_cloudwatch_log_metric_filter.this :
      filter.metric_transformation[0].namespace == "FSS/fss-test"
    ])
    error_message = "Every metric filter publishes into this environment's namespace, FSS/<name_prefix>, which is where its alarms look."
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

# The key each log group is attached to, asserted where the value exists.
#
# `aws_kms_key.logs.arn` is computed, and the mock above supplies mocked values
# during the apply phase, so this comparison cannot be made during a plan any
# more than a real one could. An apply run under a mocked provider reaches
# nothing and needs no credential.
# `docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md`.
run "every_log_group_is_encrypted_with_the_module_s_own_key" {
  command = apply

  assert {
    condition     = alltrue([for group in aws_cloudwatch_log_group.service : group.kms_key_id == aws_kms_key.logs.arn])
    error_message = "Log groups are encrypted with the module's customer key."
  }
}

