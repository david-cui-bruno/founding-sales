# ---------------------------------------------------------------------------
# Identity of the environment. These four decide every name and every
# destructive posture in the stack, and the guard in main.tf ties them
# together so a production root cannot be made destroyable and a rehearsal
# root cannot take a production name.
# ---------------------------------------------------------------------------

variable "environment" {
  description = "production or rehearsal. Each root hard-codes its own; it is not a deployment-time choice."
  type        = string

  validation {
    condition     = contains(["production", "rehearsal"], var.environment)
    error_message = "environment must be production or rehearsal."
  }
}

variable "name_prefix" {
  description = "Namespace for every resource. production is exactly fss-prod; rehearsal is fss-rh-<run>."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name_prefix)) && !endswith(var.name_prefix, "-")
    error_message = "name_prefix must be 3-25 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen."
  }
}

variable "destroyable" {
  description = "Turn off deletion protection and allow teardown. production hard-codes false."
  type        = bool
}

variable "aws_region" {
  description = "AWS region."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account id."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC."
  type        = string
  default     = "10.60.0.0/16"
}

variable "availability_zones" {
  description = "Exactly two availability zones."
  type        = list(string)
}

variable "public_subnet_cidrs" {
  description = "Two CIDR blocks for the public task subnets."
  type        = list(string)
  default     = ["10.60.0.0/20", "10.60.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Two CIDR blocks for the private database subnets."
  type        = list(string)
  default     = ["10.60.128.0/20", "10.60.144.0/20"]
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8080
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "database_multi_az" {
  description = "Multi-AZ standby. production hard-codes true."
  type        = bool
  default     = true
}

variable "database_allocated_storage" {
  description = "Provisioned gp3 storage in GiB."
  type        = number
  default     = 50
}

variable "database_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 200
}

variable "database_backup_retention_days" {
  description = "Automated backup retention, which is also the point-in-time recovery window."
  type        = number
  default     = 35
}

variable "database_performance_insights_enabled" {
  description = "Performance Insights, billed beyond the free retention."
  type        = bool
  default     = false
}

variable "database_log_min_duration_statement" {
  description = "Milliseconds above which a statement is logged."
  type        = number
  default     = 1000
}

variable "database_apply_immediately" {
  description = "Apply modifications outside the maintenance window."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

variable "api_image" {
  description = "Immutable API image digest."
  type        = string
}

variable "worker_image" {
  description = "Immutable worker image digest."
  type        = string
}

variable "api_schema_range" {
  description = "Inclusive schema versions the API binary accepts."
  type = object({
    min = number
    max = number
  })
}

variable "worker_schema_range" {
  description = "Inclusive schema versions the worker binary accepts."
  type = object({
    min = number
    max = number
  })
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64."
  type        = string
  default     = "X86_64"
}

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 2
}

variable "worker_desired_count" {
  description = "Number of worker tasks."
  type        = number
  default     = 1
}

variable "container_insights" {
  description = "enabled, enhanced or disabled."
  type        = string
  default     = "disabled"
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into a running task."
  type        = bool
  default     = false
}

variable "extra_environment" {
  description = "Additional non-secret environment variables for both tasks."
  type        = map(string)
  default     = {}
}

variable "business_time_zone" {
  description = "Workspace business zone used for the Today snapshot date. Initialized to America/New_York."
  type        = string
  default     = "America/New_York"
}

# ---------------------------------------------------------------------------
# Edge
# ---------------------------------------------------------------------------

variable "certificate_arn" {
  description = "ACM certificate ARN for the API hostname, created and DNS-validated by hand before the first apply."
  type        = string
}

variable "api_hostname" {
  description = "Public hostname the Electron client and Pub/Sub reach. Used to build the push endpoint and audience."
  type        = string
}

variable "elb_account_id" {
  description = "Region-specific Elastic Load Balancing account id, only needed in older regions."
  type        = string
  default     = ""
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the load balancer."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Secrets, journal, alerts, updates
# ---------------------------------------------------------------------------

variable "secret_names" {
  description = "Logical names of the Secrets Manager entries, each created empty."
  type        = list(string)
  default = [
    "google-oidc-client",
    "google-gmail-oauth-client",
    "session-signing-key",
    "device-credential-pepper",
    "llm-classifier-api-key",
    "research-provider-credentials",
  ]
}

variable "journal_object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE for the suppression journal."
  type        = string
  default     = "GOVERNANCE"
}

variable "journal_object_lock_retention_days" {
  description = "Default object lock retention for journal objects."
  type        = number
  default     = 3650
}

variable "alert_emails" {
  description = "Addresses that receive alerts, delivered by SNS independently of any Gmail grant."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Operational application log retention."
  type        = number
  default     = 90
}

variable "updates_price_class" {
  description = "CloudFront price class for the Electron package distribution."
  type        = string
  default     = "PriceClass_100"
}

# ---------------------------------------------------------------------------
# Gmail push
# ---------------------------------------------------------------------------

variable "enable_gmail_push" {
  description = <<-EOT
    Create the Google Cloud Pub/Sub topic and push subscription. A rehearsal
    root leaves this off unless it has its own Google Cloud project; it must
    never publish into the production project.
  EOT
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  description = "Google Cloud project that owns the Gmail push topic."
  type        = string
  default     = ""
}

variable "gmail_push_path" {
  description = "Path on the API that Pub/Sub pushes to."
  type        = string
  default     = "/integrations/gmail/push"
}

variable "extra_tags" {
  description = "Additional tags merged into every resource."
  type        = map(string)
  default     = {}
}
