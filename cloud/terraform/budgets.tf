# Monthly cost budget for everything tagged Project=callie-sourcing.
#
# NOTE: external data-vendor spend (cap $20/mo, alarm at $15) is billed
# OUTSIDE AWS and cannot be tracked by AWS Budgets. It is monitored
# separately (vendor dashboards / manual ledger), not here.
#
# NOTE: cost allocation tags must be ACTIVATED in the Billing console
# (Billing > Cost allocation tags > activate "Project") before this filter
# matches any spend. That is a one-time manual console step.

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$callie-sourcing"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
