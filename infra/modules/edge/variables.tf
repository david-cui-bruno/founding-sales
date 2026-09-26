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
  description = <<-EOT
    Path the load balancer polls. It must not require authentication and must not
    touch business state. `/readyz` (lane g81, audit S14): a task is put in service
    only once the database answers on a pooled connection, the applied schema is
    inside the range the binary declares and the system generation is the pinned
    one, and a 503 from it — `database_busy` included — takes the task out.
    `/healthz` stays the container health check, so a database outage drains
    traffic and does not by itself restart the process.
  EOT
  type        = string
  default     = "/readyz"
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
