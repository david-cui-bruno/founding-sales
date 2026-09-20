variable "name_prefix" {
  description = <<-EOT
    The production namespace. It is fixed. The validation below is half of the
    structural isolation between the two roots: production is exactly
    "fss-prod" and rehearsal is "fss-rh-<run>", so the two name spaces are
    disjoint and no rehearsal apply can address a production resource.
  EOT
  type        = string
  default     = "fss-prod"

  validation {
    condition     = var.name_prefix == "fss-prod"
    error_message = "The production root owns exactly the fss-prod namespace. Another prefix belongs in another root."
  }
}

variable "deployment_role_name" {
  description = "IAM role Terraform assumes for this root. Production and rehearsal never share one."
  type        = string
  default     = "fss-prod-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-prod-") && !startswith(var.deployment_role_name, "fss-rh-")
    error_message = "The production deployment role must live in the fss-prod- namespace."
  }
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "AWS account id. The provider refuses to act against any other account."
  type        = string
  default     = "326255650484"
}

variable "availability_zones" {
  description = "Exactly two availability zones."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "certificate_arn" {
  description = "ACM certificate for the API hostname. Created and DNS-validated by hand before the first apply."
  type        = string
}

variable "api_hostname" {
  description = "Public API hostname."
  type        = string
}

variable "api_image" {
  description = "Immutable API image digest that passed the rehearsal gate."
  type        = string
}

variable "worker_image" {
  description = "Immutable worker image digest that passed the rehearsal gate."
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

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
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

variable "database_performance_insights_enabled" {
  description = "Performance Insights, billed beyond the free retention."
  type        = bool
  default     = false
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

variable "cpu_architecture" {
  description = "X86_64 or ARM64. ARM64 is the cheaper Fargate rate but the images must be built for it."
  type        = string
  default     = "X86_64"
}

variable "container_insights" {
  description = "enabled, enhanced or disabled. Billed per metric."
  type        = string
  default     = "disabled"
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL to the load balancer."
  type        = bool
  default     = false
}

variable "elb_account_id" {
  description = "Region-specific Elastic Load Balancing account id, only needed in older regions."
  type        = string
  default     = ""
}

variable "alert_emails" {
  description = "Addresses that receive alerts. Each must confirm its subscription once by hand."
  type        = list(string)
  default     = []
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

variable "business_time_zone" {
  description = "Workspace business zone for the Today snapshot date."
  type        = string
  default     = "America/New_York"
}

variable "google_hosted_domain" {
  description = <<-EOT
    The Callie Google Workspace domain. Both task definitions carry it: the API
    refuses an id token whose `hd` differs (5.1) and a mailbox outside it
    (12.1), and the worker reads the same value so the two cannot disagree.
    A public identifier, which is why it is here rather than in a secret.
  EOT
  type        = string
  default     = "usecallie.com"

  # Repeated from the stack module deliberately: this is the operator's input,
  # and a refusal should name the variable they typed rather than one three
  # modules down. An empty domain would admit every Google account there is.
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.google_hosted_domain))
    error_message = "google_hosted_domain must be a domain name and may not be empty."
  }
}

variable "enable_gmail_push" {
  description = "Create the Gmail push topic and subscription in the production Google Cloud project."
  type        = bool
  default     = true
}

variable "gcp_project_id" {
  description = "Production Google Cloud project that owns the Gmail push topic."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_gmail_push || var.gcp_project_id != ""
    error_message = "Gmail push needs the production Google Cloud project id."
  }
}

variable "gcp_region" {
  description = "Google Cloud region for the provider."
  type        = string
  default     = "us-east1"
}
