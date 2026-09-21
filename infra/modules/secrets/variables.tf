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
    # The two database identities (G12h, David's condition of 21 September).
    # Separate entries because the point is that the identity which may read one
    # may not read the other: `infra/modules/cluster` gives the first to the
    # migration execution role alone and the second to the two services, and
    # nothing in the cluster may read the RDS-managed master secret at all.
    "migration-database",
    "app-runtime-database",
  ]

  validation {
    condition     = length(var.secret_names) > 0 && alltrue([for name in var.secret_names : can(regex("^[a-z][a-z0-9-]{2,48}$", name))])
    error_message = "Secret logical names must be lowercase letters, digits or hyphens."
  }

  # The two database entries are structural, not optional: `outputs.tf` names
  # them, `infra/modules/cluster` splits its execution-role policies along them,
  # and a caller who dropped one would otherwise get an index error four modules
  # away instead of a refusal here.
  validation {
    condition     = contains(var.secret_names, "migration-database") && contains(var.secret_names, "app-runtime-database")
    error_message = "Every environment has a migration-database entry and an app-runtime-database entry; the boundary between the two is what stops a service holding DDL credentials."
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
