variable "name_prefix" {
  description = "Namespace applied to every repository name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "repositories" {
  description = "Repository short names. One per deployable service."
  type        = list(string)
  default     = ["api", "worker"]

  validation {
    condition     = length(var.repositories) > 0 && alltrue([for name in var.repositories : can(regex("^[a-z][a-z0-9-]{1,24}$", name))])
    error_message = "Repository short names must be lowercase letters, digits or hyphens."
  }
}

variable "force_delete" {
  description = "Allow Terraform to delete a repository that still holds images. Only a destroyable rehearsal root may set true."
  type        = bool
  default     = false
}

variable "untagged_expiry_days" {
  description = "Days before an untagged image layer is expired."
  type        = number
  default     = 7
}

variable "retained_image_count" {
  description = "Number of tagged images retained per repository. Rollback needs several earlier compatible binaries."
  type        = number
  default     = 30
}

variable "kms_key_arn" {
  description = "Customer key for repository encryption. Null uses AES256 with an AWS-owned key."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
