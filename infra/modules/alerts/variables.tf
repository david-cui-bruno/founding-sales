variable "name_prefix" {
  description = "Namespace applied to every topic and alarm name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the topic."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "alert_emails" {
  description = <<-EOT
    Addresses that receive the daily alarm digest (digest.tf), the one e-mail
    this module sends. SNS email delivery is AWS-native and does not touch a
    salesperson Gmail grant, so a revoked or unhealthy mailbox cannot silence
    the digest that says the mailbox is unhealthy. Each address must confirm
    its subscription by hand once; see the runbook.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.alert_emails : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", address))])
    error_message = "Every alert recipient must look like an email address."
  }
}

variable "metric_namespace" {
  description = "CloudWatch namespace every alarm reads: the one the applications and the metric filters publish to. FSS/<name_prefix>, derived once in infra/modules/stack. No default: the bare FSS namespace was shared by every environment in the account (g42)."
  type        = string

  validation {
    condition     = can(regex("^FSS/[a-z][a-z0-9-]{2,31}$", var.metric_namespace))
    error_message = "metric_namespace must be FSS/<name_prefix>, one namespace per environment. The bare FSS namespace is shared by every environment in the account, so a rehearsal publishing there feeds production's alarms."
  }
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}

variable "kms_key_arn" {
  description = <<-EOT
    The customer key that encrypts the alert topic and the digest function's
    environment: the observability module's log key, whose policy admits
    cloudwatch.amazonaws.com and events.amazonaws.com (logs and alerts share one
    key, David, 20 September 2026). It is a value the same apply computes, so
    nothing in this module branches on it.
  EOT
  type        = string
}
