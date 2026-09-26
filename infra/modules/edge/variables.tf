variable "name_prefix" {
  description = "Namespace applied to every resource name in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "aws_account_id" {
  description = "Account that owns the access-log bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "An AWS account id is twelve digits."
  }
}

variable "vpc_id" {
  description = "VPC the target group lives in."
  type        = string
}

variable "subnet_ids" {
  description = "The two public subnets the load balancer is attached to."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the load balancer. Expect exactly the ALB group from the network module."
  type        = list(string)
}

variable "certificate_arn" {
  description = <<-EOT
    ACM certificate ARN for the API hostname. David creates the certificate and
    completes DNS validation by hand before the first apply; see the runbook.
  EOT
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN."
  }
}

variable "container_port" {
  description = "Port the API container listens on."
  type        = number
  default     = 8080
}

variable "enable_deletion_protection" {
  description = "Refuse deletion of the load balancer. Only a destroyable rehearsal root sets false."
  type        = bool
  default     = true
}

variable "force_destroy_logs" {
  description = "Allow Terraform to empty the access-log bucket on destroy."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
