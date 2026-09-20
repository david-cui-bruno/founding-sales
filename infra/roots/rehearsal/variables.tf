variable "name_prefix" {
  description = <<-EOT
    The rehearsal namespace for one run. It must be fss-rh-<run>. The
    validation below is the other half of the structural isolation: it refuses
    the production namespace outright, so no rehearsal apply and no rehearsal
    teardown can address a production resource.
  EOT
  type        = string
  default     = "fss-rh-default"

  validation {
    condition     = can(regex("^fss-rh-[a-z0-9][a-z0-9-]{1,16}[a-z0-9]$", var.name_prefix))
    error_message = "A rehearsal namespace must be fss-rh-<run>, 3 to 18 lowercase characters after the prefix, not ending in a hyphen."
  }

  validation {
    condition     = var.name_prefix != "fss-prod" && !startswith(var.name_prefix, "fss-prod")
    error_message = "fss-prod is the production namespace. A rehearsal root may never take it."
  }
}

variable "deployment_role_name" {
  description = <<-EOT
    IAM role Terraform assumes for this run. Its policy is scoped to the
    fss-rh-* namespace, so even a mistaken destroy has no permission to touch
    a production resource. Production and rehearsal never share a role.
  EOT
  type        = string
  default     = "fss-rh-deploy"

  validation {
    condition     = startswith(var.deployment_role_name, "fss-rh-") && !startswith(var.deployment_role_name, "fss-prod")
    error_message = "The rehearsal deployment role must live in the fss-rh- namespace."
  }
}

variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "aws_account_id" {
  description = "AWS account id."
  type        = string
  default     = "326255650484"
}

variable "availability_zones" {
  description = "Exactly two availability zones. Both subnets pairs are spread across them even when the database is single-AZ."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block. A rehearsal run may use a different range from production."
  type        = string
  default     = "10.70.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Two CIDR blocks for the public task subnets."
  type        = list(string)
  default     = ["10.70.0.0/20", "10.70.16.0/20"]
}

variable "private_subnet_cidrs" {
  description = "Two CIDR blocks for the private database subnets."
  type        = list(string)
  default     = ["10.70.128.0/20", "10.70.144.0/20"]
}

variable "certificate_arn" {
  description = "ACM certificate for the rehearsal API hostname."
  type        = string
}

variable "api_hostname" {
  description = "Rehearsal API hostname. Never the production hostname."
  type        = string
}

variable "api_image" {
  description = "The exact immutable API digest proposed for production."
  type        = string
}

variable "worker_image" {
  description = "The exact immutable worker digest proposed for production."
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

variable "database_multi_az" {
  description = "Rehearsal may run single-AZ. Production cannot."
  type        = bool
  default     = false
}

variable "database_instance_class" {
  description = "RDS instance class. Rehearsal defaults to the smallest usable class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage" {
  description = "Provisioned gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "database_backup_retention_days" {
  description = <<-EOT
    Backup retention for the rehearsal database. One day is enough to exercise
    the restore drill; the drill restores to a point inside the run.
  EOT
  type        = number
  default     = 1
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task."
  type        = number
  default     = 512
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. Must match the digests proposed for production."
  type        = string
  default     = "X86_64"
}

variable "api_desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 1
}

variable "worker_desired_count" {
  description = "Number of worker tasks."
  type        = number
  default     = 1
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into a rehearsal task while investigating a scenario."
  type        = bool
  default     = false
}

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL."
  type        = bool
  default     = false
}

variable "elb_account_id" {
  description = "Region-specific Elastic Load Balancing account id, only needed in older regions."
  type        = string
  default     = ""
}

variable "alert_emails" {
  description = "Addresses that receive rehearsal alerts."
  type        = list(string)
  default     = []
}

variable "journal_object_lock_retention_days" {
  description = <<-EOT
    Object lock retention for the rehearsal journal. One day, because an
    object-locked object refuses deletion until its retention expires and a
    rehearsal environment has to be able to disappear. Governance mode plus a
    one-day retention keeps the replay test honest without leaving a bucket
    that cannot be removed.
  EOT
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "Rehearsal log retention. Short, because the run is short."
  type        = number
  default     = 7
}

variable "business_time_zone" {
  description = "Workspace business zone for the Today snapshot date."
  type        = string
  default     = "America/New_York"
}

variable "enable_gmail_push" {
  description = <<-EOT
    Off by default. Rehearsal must never publish into the production Google
    Cloud project; turning it on requires its own gcp_project_id.
  EOT
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  description = "A rehearsal-only Google Cloud project. Never the production project."
  type        = string
  default     = ""

  validation {
    condition     = !var.enable_gmail_push || var.gcp_project_id != ""
    error_message = "Gmail push needs a rehearsal-only Google Cloud project id. A rehearsal run must never publish into the production project."
  }
}

variable "gcp_region" {
  description = "Google Cloud region for the provider."
  type        = string
  default     = "us-east1"
}
