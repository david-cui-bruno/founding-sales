# David's decision of 20 Sep 2026: the alert topic shares the log key. With a key
# passed in, this module creates no key and no alias of its own, and the topic
# is encrypted with the key it was given.
mock_provider "aws" {
  override_during = plan

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:fss-test-alerts"
    }
  }
}

variables {
  name_prefix      = "fss-test"
  aws_account_id   = "123456789012"
  alert_emails     = ["ops@example.invalid"]
  metric_namespace = "FSS/test"
  kms_key_arn      = "arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
}

run "a_shared_key_means_no_key_of_our_own" {
  command = plan

  assert {
    condition     = length(aws_kms_key.alerts) == 0 && length(aws_kms_alias.alerts) == 0
    error_message = "With kms_key_arn set, the alerts module must not create a key or alias."
  }

  assert {
    condition     = aws_sns_topic.alerts.kms_master_key_id == var.kms_key_arn
    error_message = "The topic must be encrypted with the shared key it was given."
  }

  assert {
    condition     = output.kms_key_arn == var.kms_key_arn
    error_message = "The module must report the shared key as its key."
  }
}
