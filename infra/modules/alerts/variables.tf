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
  description = "The newest canary's scheduler-to-worker latency, in seconds, that alarm: a run inserted and not completed for this long alarms. The canary is inserted once per workspace per quarter hour and proves scheduler-to-worker completion, so this is the gap between the insert and the completion — not the gap between one completion and the next, which sawtooths to 900 on a healthy system (g41)."
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

variable "mailbox_coverage_stale_seconds" {
  description = <<-EOT
    Seconds a connected, ready mailbox's coverage watermark may age before the
    warning mailbox_coverage_stale (lane g81). The same fifteen minutes as
    COVERAGE_FRESHNESS_SECONDS in packages/domain/mail/coverage.ts, past which the
    send path holds that owner's automated email; test/release/alarmIncidents.check.ts
    keeps the two equal.
  EOT
  type        = number
  default     = 900

  validation {
    condition     = var.mailbox_coverage_stale_seconds > 0
    error_message = "mailbox_coverage_stale_seconds must be a positive number of seconds."
  }
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

variable "create_kms_key" {
  description = <<-EOT
    Whether this module creates the customer key that encrypts the alert topic.

    It is a boolean the caller states rather than `kms_key_arn == null`, and the
    difference is the whole reason this variable exists. The ARN a real stack
    passes is `module.observability.kms_key_arn`, a key created in the *same*
    apply: while Terraform plans, that value is unknown — not even its nullness
    is decided — and a `count` that depends on an unknown is refused before AWS
    is touched ("The count value depends on resource attributes that cannot be
    determined until apply"). David's third credentialed rehearsal stopped
    there, in `terraform plan`, on the expression this replaces.

    `docs/archive/decisions/g12j-the-alert-key-is-a-boolean-not-a-null-check.md`.
  EOT
  type        = bool
  default     = true

  validation {
    # Fail closed, and fail where the plan can see it. With a literal null ARN
    # this is refused at plan time and names the variable the caller typed. With
    # an ARN created in the same apply the condition is unknown while planning,
    # so Terraform defers the check to the apply, where the ARN is a string and
    # the answer is real. Either way there is no path to an alert topic with no
    # key at all.
    condition     = var.create_kms_key || var.kms_key_arn != null
    error_message = "create_kms_key = false means the topic is encrypted with a key it was given, so kms_key_arn must be set. An alert topic with no customer key is not one of the options: CloudWatch cannot publish through the AWS-managed SNS key."
  }
}

variable "kms_key_arn" {
  description = <<-EOT
    An existing customer key for the alert topic, read only when
    `create_kms_key` is false. Its policy must already admit
    cloudwatch.amazonaws.com and events.amazonaws.com; the observability module
    does so with `shared_with_alerts = true`, which is how logs and alerts share
    one key (David, 20 September 2026).

    It may be a value this apply computes. Nothing in this module branches on it.
  EOT
  type        = string
  default     = null
}
