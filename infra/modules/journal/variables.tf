variable "name_prefix" {
  description = "Namespace applied to the bucket and key names in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the journal bucket. Used to build the writer and reader role ARNs."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "writer_role_name" {
  description = <<-EOT
    Name of the API task role, the only principal permitted to put an object.
    Passed as a name rather than an ARN so this module does not depend on the
    cluster module, which in turn depends on this bucket's ARN.
  EOT
  type        = string
}

variable "reader_role_names" {
  description = "Roles permitted to read the journal. The worker reads it to replay suppression events after a restore."
  type        = list(string)
  default     = []
}

variable "object_lock_mode" {
  description = "GOVERNANCE or COMPLIANCE. COMPLIANCE cannot be shortened or removed by anyone, including the account root."
  type        = string
  default     = "GOVERNANCE"

  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.object_lock_mode)
    error_message = "Object lock mode must be GOVERNANCE or COMPLIANCE."
  }
}

variable "object_lock_retention_days" {
  description = "Default retention applied to every journal object. Suppression history is retained indefinitely, so production sets this long."
  type        = number
  default     = 3650

  validation {
    condition     = var.object_lock_retention_days >= 1
    error_message = "Object lock retention must be at least one day."
  }
}

variable "force_destroy" {
  description = "Allow Terraform to empty the bucket on destroy. Object-locked objects still refuse deletion until their retention expires."
  type        = bool
  default     = false
}

variable "kms_deletion_window_days" {
  description = "Waiting period before the customer key is destroyed."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
