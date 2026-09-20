mock_provider "aws" {
  override_during = plan

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }
}

variables {
  name_prefix    = "fss-test"
  aws_region     = "us-east-1"
  aws_account_id = "123456789012"
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
    condition     = alltrue([for group in aws_cloudwatch_log_group.service : group.kms_key_id == aws_kms_key.logs.arn])
    error_message = "Log groups are encrypted with the module's customer key."
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

  assert {
    condition = alltrue([
      for filter in aws_cloudwatch_log_metric_filter.this :
      filter.metric_transformation[0].namespace == "FSS"
    ])
    error_message = "Every metric filter publishes into the FSS namespace."
  }
}

run "an_undocumented_retention_value_is_refused" {
  command = plan

  variables {
    retention_days = 45
  }

  expect_failures = [var.retention_days]
}
