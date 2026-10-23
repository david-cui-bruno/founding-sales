variable "browser_certificate_arn" {
  description = "Optional existing browser ACM certificate, attached additively to the API HTTPS listener. No certificate or DNS is provisioned."
  type        = string
  default     = null

  validation {
    condition     = var.browser_certificate_arn == null ? true : can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[a-zA-Z0-9-]+$", var.browser_certificate_arn))
    error_message = "browser_certificate_arn must be an existing ACM certificate ARN or null."
  }
}

locals {
  browser_certificates = var.browser_certificate_arn == null ? {} : { browser = var.browser_certificate_arn }
}

resource "aws_lb_listener_certificate" "browser" {
  for_each = local.browser_certificates

  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = each.value
}

output "browser_certificate_arn" {
  description = "Additional browser certificate reference, if configured. API default certificate is unchanged."
  value       = var.browser_certificate_arn
}
