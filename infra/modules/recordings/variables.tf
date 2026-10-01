variable "name_prefix" {
  description = "Namespace applied to the bucket name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the bucket; part of its globally unique name."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "object_expiration_days" {
  description = "Days after which every object expires. One, by David's decision of 1 October 2026; the worker deletes each object itself as soon as its job ends."
  type        = number
  default     = 1

  validation {
    condition     = var.object_expiration_days == 1
    error_message = "Call audio is kept for one day at most (slice C3a)."
  }
}

variable "force_destroy" {
  description = "Whether a destroy may remove a bucket that still holds objects. True for a rehearsal only."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
