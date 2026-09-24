variable "name_prefix" {
  description = "Namespace applied to every log group and metric filter in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_region" {
  description = "Region, used in the log-group key policy for the CloudWatch Logs service principal."
  type        = string
}

variable "aws_account_id" {
  description = "Account that owns the log groups."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "retention_days" {
  description = "Operational application log retention. The retention table says 90 days, bodies and secrets excluded."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.retention_days)
    error_message = "CloudWatch Logs accepts only its documented retention values."
  }
}

variable "services" {
  description = "Service short names that get a log group."
  type        = list(string)
  default     = ["api", "worker"]
}

variable "metric_namespace" {
  description = "CloudWatch namespace the metric filters and the applications publish to. FSS/<name_prefix>, derived once in infra/modules/stack. No default: the bare FSS namespace was shared by every environment in the account (g42)."
  type        = string

  validation {
    condition     = can(regex("^FSS/[a-z][a-z0-9-]{2,31}$", var.metric_namespace))
    error_message = "metric_namespace must be FSS/<name_prefix>, one namespace per environment. The bare FSS namespace is shared by every environment in the account, so a rehearsal publishing there feeds production's alarms."
  }
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the log customer key is destroyed."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}

variable "shared_with_alerts" {
  description = "When true, the log key policy also lets CloudWatch alarms and EventBridge use the key, so the alert topic can share it (five keys instead of six, David's decision of 20 Sep 2026)."
  type        = bool
  default     = false
}
