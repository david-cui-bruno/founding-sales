variable "aws_region" {
  description = "AWS region for all resources. SES inbound receiving requires a supported region (us-east-1)."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "The shared AWS account this stack is allowed to deploy into."
  type        = string
  default     = "326255650484"
}

variable "name_prefix" {
  description = "Prefix for every named resource in the shared account."
  type        = string
  default     = "callie-sourcing"
}

variable "iam_path" {
  description = "IAM path namespace for all roles, users and policies in the shared account."
  type        = string
  default     = "/callie-sourcing/"
}

variable "root_domain" {
  description = "Root domain whose Route53 hosted zone already exists in this account (not managed here)."
  type        = string
  default     = "usecallie.com"
}

variable "inbound_mail_subdomain" {
  description = "Subdomain dedicated to SES inbound mail."
  type        = string
  default     = "in.usecallie.com"
}

variable "inbound_recipient" {
  description = "Recipient address the SES receipt rule matches."
  type        = string
  default     = "alerts@in.usecallie.com"
}

variable "budget_notification_email" {
  description = "Email address that receives AWS Budgets notifications. Placeholder default; override in terraform.tfvars before apply."
  type        = string
  default     = "billing-placeholder@usecallie.com"
}

variable "monthly_budget_limit_usd" {
  description = "Monthly AWS cost budget (USD) for resources tagged Project=callie-sourcing."
  type        = string
  default     = "50"
}

variable "schedules_enabled" {
  description = "Master switch for every scheduled sourcing and watchdog EventBridge rule. Keep false until an approved production rollout."
  type        = bool
  default     = false
}

variable "scheduled_health_alerts_enabled" {
  description = "Enables notification actions for scheduled missing-success and persistent-work health alarms after an approved baseline."
  type        = bool
  default     = false
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

variable "delegated_research_reviewed_capability" {
  description = "Optional non-secret operator-reviewed research settings JSON, at most 3000 characters. Empty requires operator setup. Not readiness, provider connectivity or verified pricing proof. No credentials, model defaults or default rates. Runtime validates descriptor semantics and freshness."
  type        = string
  default     = ""
  nullable    = false
  validation {
    condition     = length(var.delegated_research_reviewed_capability) <= 3000 && (var.delegated_research_reviewed_capability == "" || can(jsondecode(var.delegated_research_reviewed_capability)))
    error_message = "Reviewed research metadata must be empty or valid non-secret JSON of at most 3000 characters."
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
