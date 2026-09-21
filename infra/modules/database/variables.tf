variable "name_prefix" {
  description = "Namespace applied to every resource name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "subnet_ids" {
  description = "The two private subnets. RDS is never placed in a public subnet."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) == 2
    error_message = "Provide exactly two private subnet ids, one per availability zone."
  }
}

variable "vpc_security_group_ids" {
  description = "Security groups attached to the instance. Expect exactly the database group from the network module."
  type        = list(string)
}

variable "engine_version" {
  description = <<-EOT
    PostgreSQL engine version, **by major**. The design targets PostgreSQL 16
    and the default is the bare major, `"16"`.

    It was `"16.8"` until David's fourth credentialed rehearsal, which reached
    AWS and was refused:

        InvalidParameterCombination: Cannot find version 16.8 for postgres

    AWS had retired 16.8. The versions available in `us-east-1` on 21 September
    2026 were 16.3, 16.4, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14 and 16.15, and
    a pinned minor goes away on AWS's schedule rather than ours. Nothing offline
    can see it: no `terraform validate`, no mocked `terraform test` and no plan
    ever asks RDS which versions exist, so a pinned minor is discovered by an
    apply — and an apply is the most expensive place in this release to learn
    anything.

    With `auto_minor_version_upgrade = true`, which `main.tf` sets, the AWS
    provider treats a major-only `engine_version` as a prefix: it records the
    full version AWS chose in state and suppresses the diff for as long as the
    running version still begins with the configured string. So `"16"` plans as
    no change against 16.9 or 16.15, and `"16.8"` planned as a change against
    anything. `docs/decisions/g16-postgresql-is-pinned-by-major.md`.

    A minor **may** still be pinned — to reproduce a bug, or to hold a restored
    instance at the source's version — and the validation below accepts one.
    What it refuses is a different major, which is a spec change.
  EOT
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.engine_version))
    error_message = "The design targets PostgreSQL 16, as the bare major \"16\" or as 16.<minor>. A different major version is a spec change."
  }
}

variable "instance_class" {
  description = "RDS instance class. Priced per hour and doubled by Multi-AZ."
  type        = string
  default     = "db.t4g.small"
}

variable "multi_az" {
  description = "Multi-AZ standby. Production is always true; rehearsal may run single-AZ."
  type        = bool
  default     = true
}

variable "allocated_storage" {
  description = "Provisioned gp3 storage in GiB."
  type        = number
  default     = 50
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB. Set to 0 to disable autoscaling."
  type        = number
  default     = 200
}

variable "backup_retention_days" {
  description = "Automated backup retention. Point-in-time recovery is available across this window."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "Backup retention must be between 1 and 35 days. The design target is 35."
  }
}

variable "backup_window" {
  description = "Daily UTC backup window, outside the workspace business day."
  type        = string
  default     = "07:30-08:00"
}

variable "maintenance_window" {
  description = "Weekly UTC maintenance window, outside the workspace business day."
  type        = string
  default     = "sun:08:30-sun:09:30"
}

variable "deletion_protection" {
  description = "Refuse deletion of the instance. Production sets true and cannot set false."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Only a destroyable rehearsal root may set true."
  type        = bool
  default     = false
}

variable "performance_insights_enabled" {
  description = "Performance Insights. Optional and priced per vCPU beyond the free retention."
  type        = bool
  default     = false
}

variable "performance_insights_retention_period" {
  description = "Performance Insights retention in days. 7 is the free tier."
  type        = number
  default     = 7
}

variable "monitoring_interval" {
  description = "Enhanced Monitoring interval in seconds. 0 disables it."
  type        = number
  default     = 0
}

variable "log_min_duration_statement" {
  description = "Milliseconds above which a statement is logged. -1 disables statement duration logging."
  type        = number
  default     = 1000
}

variable "database_name" {
  description = "Initial database name."
  type        = string
  default     = "fss"
}

variable "master_username" {
  description = "Master user name. Not a secret. The password is generated and rotated by RDS in Secrets Manager and never appears in Terraform."
  type        = string
  default     = "fss_admin"
}

variable "port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the customer key is destroyed."
  type        = number
  default     = 30
}

variable "apply_immediately" {
  description = "Apply modifications outside the maintenance window."
  type        = bool
  default     = false
}

variable "ca_cert_identifier" {
  description = "RDS certificate authority for TLS connections."
  type        = string
  default     = "rds-ca-rsa2048-g1"
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
