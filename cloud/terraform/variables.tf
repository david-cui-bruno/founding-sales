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

variable "ntfy_topic" {
  description = "ntfy.sh topic for hot-lead pushes (value lives in SSM /callie-sourcing/ntfy-topic). Empty disables pushes."
  type        = string
  default     = ""
  sensitive   = true
}

variable "tracerfy_api_key" {
  description = "Tracerfy API bearer token for the enricher Lambda. Canonical value lives in SSM /callie-sourcing/tracerfy-api-key; wire it through terraform.tfvars. The sandbox (mock.tracerfy.com) accepts any non-empty token."
  type        = string
  sensitive   = true
}

variable "schedules_enabled" {
  description = "Master switch for the adapter/scorer/resolver/enricher EventBridge schedules. Flipped to true 2026-09-02 after the founder-delegated quality pass (top-25 verified against city records, 88% pass at scores v2). Set false to pause the whole pipeline."
  type        = bool
  default     = true
}
