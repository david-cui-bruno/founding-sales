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

variable "delete_automated_backups" {
  description = "Delete the instance's automated backups when it is deleted, rather than keep them for their retention period. Only a destroyable rehearsal root may set true."
  type        = bool
  default     = false
}

variable "log_min_duration_statement" {
  description = "Milliseconds above which a statement is logged. -1 disables statement duration logging."
  type        = number
  default     = 1000
}

variable "port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "apply_immediately" {
  description = "Apply modifications outside the maintenance window."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
