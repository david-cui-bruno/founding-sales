# The error David's third credentialed rehearsal stopped on, offline.
#
#   Error: Invalid count argument
#     on ../../modules/alerts/main.tf line 262:
#     count = var.kms_key_arn == null ? 1 : 0
#   The "count" value depends on resource attributes that cannot be determined
#   until apply.
#
# Every other test in this module passes a literal ARN, and a literal is never
# unknown. The stack passes `module.observability.kms_key_arn`, a key created in
# the same apply, so `var.kms_key_arn == null` is unknown while Terraform plans
# and a `count` may not depend on an unknown. `tests/harness` is that shape.
#
# `override_during = apply` is what makes the mock behave like the real
# provider: the mocked attributes below are supplied during the apply phase and
# stay unknown for the whole plan. With `override_during = plan` this file would
# pass against the expression that broke the rehearsal.
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

run "a_key_created_in_the_same_apply_plans" {
  command = plan

  module {
    source = "./tests/harness"
  }

  assert {
    condition     = output.topic_name == "fss-test-alerts"
    error_message = "The topic is still named from the prefix."
  }

  # The whole inventory has to plan, not just the key decision: an alarm that
  # referenced the absent key would fail here rather than in the account.
  assert {
    condition     = length(output.alarm_names) == length(keys(output.alarm_inventory)) + 1
    error_message = "Every declared alarm plus the metric-math one must plan when the topic key comes from elsewhere in the same apply."
  }
}
