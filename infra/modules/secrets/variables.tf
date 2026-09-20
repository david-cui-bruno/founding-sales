variable "name_prefix" {
  description = "Namespace applied to every secret and key name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "secret_names" {
  description = <<-EOT
    Logical names of the Secrets Manager entries this environment needs. Each
    entry is created empty. Terraform never writes, reads or plans a value: the
    values are entered once by hand under the apply runbook.
  EOT
  type        = list(string)
  default = [
    "google-oidc-client",
    "google-gmail-oauth-client",
    "session-signing-key",
    "device-credential-pepper",
    "llm-classifier-api-key",
    "research-provider-credentials",
  ]

  validation {
    condition     = length(var.secret_names) > 0 && alltrue([for name in var.secret_names : can(regex("^[a-z][a-z0-9-]{2,48}$", name))])
    error_message = "Secret logical names must be lowercase letters, digits or hyphens."
  }
}

variable "recovery_window_days" {
  description = "Days a deleted secret stays recoverable. 0 deletes immediately and belongs only to a destroyable rehearsal root."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_window_days == 0 || (var.recovery_window_days >= 7 && var.recovery_window_days <= 30)
    error_message = "Secrets Manager accepts 0 (immediate) or 7 to 30 days."
  }
}

variable "kms_deletion_window_days" {
  description = "Waiting period before a customer key is destroyed."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
