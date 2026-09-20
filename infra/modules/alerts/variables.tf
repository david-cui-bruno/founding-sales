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
    Addresses that receive alerts. SNS email delivery is AWS-native and does
    not touch a salesperson Gmail grant, so a revoked or unhealthy mailbox
    cannot silence the alarm that says the mailbox is unhealthy. Each address
    must confirm its subscription by hand once; see the runbook.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.alert_emails : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", address))])
    error_message = "Every alert recipient must look like an email address."
  }
}

variable "metric_namespace" {
  description = "CloudWatch namespace the applications and metric filters publish to."
  type        = string
  default     = "FSS"
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the topic customer key is destroyed."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------
# Thresholds. Spec 13.3 says these are configuration, versioned with the
# release, so every one of them is a variable with the spec value as default.
# ---------------------------------------------------------------------------

variable "heartbeat_missed_checks" {
  description = "Consecutive missed one-minute checks before a heartbeat alarms."
  type        = number
  default     = 3
}

variable "oldest_job_age_warning_seconds" {
  description = "Age of the oldest runnable job that warns."
  type        = number
  default     = 300
}

variable "oldest_job_age_critical_seconds" {
  description = "Age of the oldest runnable job that is critical."
  type        = number
  default     = 900
}

variable "gmail_watch_expiry_hours" {
  description = "Hours to Gmail watch expiry that alarm."
  type        = number
  default     = 48
}

variable "canary_stale_seconds" {
  description = "Seconds without a completed canary that alarm. The canary is inserted every 15 minutes and proves scheduler-to-worker completion."
  type        = number
  default     = 300
}

variable "dead_job_unresolved_seconds" {
  description = "Seconds a dead job may remain unresolved."
  type        = number
  default     = 3600
}

variable "mailbox_disconnected_hours" {
  description = "Hours a mailbox that sent in the last 30 days may stay disconnected."
  type        = number
  default     = 48
}

variable "unacknowledged_critical_seconds" {
  description = <<-EOT
    Seconds a critical alert may stay unacknowledged before it is re-raised.
    The applications emit UnacknowledgedCriticalAlertAgeSeconds; this alarm is
    how "repeated while critical and unacknowledged" is delivered, because
    CloudWatch itself notifies only on state transitions.
  EOT
  type        = number
  default     = 3600
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}

variable "kms_key_arn" {
  description = "An existing customer key for the alert topic. When set, this module creates no key of its own and the key's policy must already admit cloudwatch.amazonaws.com and events.amazonaws.com (the observability module does so with shared_with_alerts = true). Null creates a dedicated key."
  type        = string
  default     = null
}
