variable "aws_region" {
  description = "AWS region for the worker resources."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "The shared AWS account this worker is allowed to deploy into."
  type        = string
  default     = "326255650484"
}

variable "name_prefix" {
  description = "Prefix for every named worker resource in the shared account."
  type        = string
  default     = "callie-sourcing"
}

variable "iam_path" {
  description = "IAM path namespace for the worker role in the shared account."
  type        = string
  default     = "/callie-sourcing/"
}

variable "delegated_worker_enabled" {
  description = "Separate opt-in worker. Never enables any existing schedule or sender."
  type        = bool
  default     = false
}

variable "delegated_worker_activation_reviewed" {
  description = "Explicit deployment/cost/security approval after offline and distributed acceptance gates. Not permission to send mail."
  type        = bool
  default     = false
}

variable "delegated_workspace_id" {
  description = "Dedicated workspace identifier. No account/workspace default."
  type        = string
  default     = ""
  validation {
    condition     = var.delegated_workspace_id == "" || can(regex("^[A-Za-z0-9_-]{1,128}$", var.delegated_workspace_id))
    error_message = "Use a bounded plain workspace identifier."
  }
}

variable "delegated_google_client_id" {
  description = "Separate remote Google OAuth client ID. Empty leaves Google grants unconfigured. Secret/key values are never in Terraform state."
  type        = string
  default     = ""
}

variable "delegated_research_enabled" {
  description = "Opt-in access to the selected workspace research-model-credentials SecureString. Does not approve a budget, source configuration or model request. Secret values are provisioned separately, never stored in Terraform."
  type        = bool
  default     = false
}

variable "delegated_places_enabled" {
  description = "Opt-in access to the selected workspace places-api-credentials SecureString for Google Places territory discovery. Does not approve a budget, a territory configuration or any call. Secret values are provisioned separately, never stored in Terraform."
  type        = bool
  default     = false
}

variable "delegated_research_reviewed_capability" {
  description = "Optional non-secret operator-reviewed research settings JSON, at most 3000 characters with a provenance of at most 500 characters. Empty requires operator setup. Not readiness, provider connectivity or verified pricing proof. No credentials, model defaults or default rates. Runtime validates descriptor semantics and freshness."
  type        = string
  default     = ""
  nullable    = false
  validation {
    condition     = length(var.delegated_research_reviewed_capability) <= 3000 && (var.delegated_research_reviewed_capability == "" || can(jsondecode(var.delegated_research_reviewed_capability)))
    error_message = "Reviewed research metadata must be empty or valid non-secret JSON of at most 3000 characters."
  }
  # The worker's shared schema caps provenance at 500 characters; a descriptor Terraform accepts must be one the worker accepts.
  validation {
    condition     = try(length(tostring(jsondecode(var.delegated_research_reviewed_capability).provenance)), 0) <= 500
    error_message = "Reviewed research metadata provenance must be at most 500 characters."
  }
}

variable "delegated_worker_research_once_enabled" {
  description = "Explicit IAM research-only invocation opt-in. Requires continuous worker scheduling off. Does not approve research, provision credentials, grant accounts or permit outreach."
  type        = bool
  default     = false
}

variable "delegated_worker_schedule_enabled" {
  description = "Opt-in dedicated five-minute delegated-worker schedule, requiring worker enablement and existing activation review. Never changes existing schedules. Runtime ownership, grants, budgets and exact approvals remain mandatory."
  type        = bool
  default     = false
}

variable "worker_source_dir" {
  description = "Caller-owned path to the separately built delegated-worker dist directory. No build is run by Terraform."
  type        = string
}

variable "worker_output_path" {
  description = "Caller-owned archive output path. Keep each root's build artifacts separate."
  type        = string
}

variable "alarm_email" {
  description = "Optional address for the worker alarm topic and budget notifications. Empty creates no subscription; a set address must confirm the SNS subscription by mail. Never a credential."
  type        = string
  default     = ""
  nullable    = false
  validation {
    condition     = var.alarm_email == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alarm_email))
    error_message = "alarm_email must be empty or one plain email address."
  }
}

variable "monthly_budget_usd" {
  description = "Account-wide monthly AWS Budget in whole USD. Notifications fire at 100% and 200% of this amount (USD 25 and USD 50 by default) and on a 100% forecast. A notification, never a hard billing cap."
  type        = number
  default     = 25
  nullable    = false
  validation {
    condition     = var.monthly_budget_usd >= 1 && var.monthly_budget_usd <= 1000 && floor(var.monthly_budget_usd) == var.monthly_budget_usd
    error_message = "monthly_budget_usd must be a whole number of USD between 1 and 1000."
  }
}
