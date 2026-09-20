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

variable "health_check_path" {
  description = "Path the load balancer polls. It must not require authentication and must not touch business state."
  type        = string
  default     = "/healthz"
}

variable "ssl_policy" {
  description = "ALB TLS policy. TLS 1.2 is the floor."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "idle_timeout_seconds" {
  description = "Load balancer idle timeout."
  type        = number
  default     = 60
}

variable "access_log_retention_days" {
  description = "Days load-balancer access logs are kept. Retained independently of application logs."
  type        = number
  default     = 365
}

variable "elb_account_id" {
  description = <<-EOT
    Region-specific Elastic Load Balancing account id, a public AWS-documented
    constant. Older regions deliver access logs as this account rather than as
    the logdelivery service principal. Leave empty to rely on the service
    principal alone; see the runbook.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.elb_account_id == "" || can(regex("^[0-9]{12}$", var.elb_account_id))
    error_message = "elb_account_id must be empty or twelve digits."
  }
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

variable "enable_waf" {
  description = "Attach a WAFv2 web ACL. Off by default; WAF is billed per ACL, per rule and per request."
  type        = bool
  default     = false
}

variable "waf_rate_limit_per_five_minutes" {
  description = "Requests per five minutes per source address before the WAF rate rule blocks. Only used when enable_waf is true."
  type        = number
  default     = 2000
}

variable "tags" {
  description = "Tags merged into every resource in this module."
  type        = map(string)
  default     = {}
}
