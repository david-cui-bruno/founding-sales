# The shape the stack really has, small enough to read in one screen.
#
# `infra/modules/stack` passes `module.observability.kms_key_arn` into this
# module, and that ARN belongs to a key created in the same apply. No plan can
# know it — not even whether it is null. The harness reproduces exactly that:
# one `aws_kms_key` and the alerts module given its ARN.
#
# The test file that uses this harness mocks the provider with
# `override_during = apply`, so the mocked ARN stays unknown for the whole plan
# phase, which is what a real plan sees. `override_during = plan` would hand the
# plan a known value and hide the only interesting case.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

# The observability module's log key, stood in for by one resource.
resource "aws_kms_key" "shared" {
  description             = "fss-test logs and alerts."
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

module "alerts" {
  source = "../.."

  name_prefix      = "fss-test"
  aws_account_id   = "123456789012"
  alert_emails     = ["ops@example.invalid"]
  metric_namespace = "FSS/test"

  # David's decision of 20 September 2026: logs and alerts share one key, so
  # the stack creates none here and passes the one it already has. The literal
  # false is the whole fix: it is a value the plan knows.
  create_kms_key = false
  kms_key_arn    = aws_kms_key.shared.arn
}

output "created_own_kms_key" {
  description = "Whether the alerts module created a key of its own."
  value       = module.alerts.created_own_kms_key
}

output "alarm_names" {
  description = "Every alarm name the module planned."
  value       = module.alerts.alarm_names
}

output "alarm_inventory" {
  description = "The declared alarm inventory."
  value       = module.alerts.alarm_inventory
}

output "topic_name" {
  description = "The alert topic name."
  value       = module.alerts.topic_name
}
