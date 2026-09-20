variable "name_prefix" {
  description = "Namespace applied to the bucket and distribution in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "price_class" {
  description = "CloudFront price class. One salesperson on one continent does not need the global class."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "aliases" {
  description = "Optional custom hostnames. Requires acm_certificate_arn in us-east-1."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate in us-east-1 for the custom hostnames. Null uses the default CloudFront certificate."
  type        = string
  default     = null
}

variable "noncurrent_version_expiration_days" {
  description = "Days a superseded package version is kept. Rollback needs earlier compatible binaries."
  type        = number
  default     = 365
}

variable "force_destroy" {
  description = "Allow Terraform to empty the bucket on destroy."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
