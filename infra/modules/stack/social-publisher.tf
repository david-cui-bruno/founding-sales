variable "social_publisher_runtime_ready" {
  description = "Buffer credential encryption key is populated and public media ingress is configured; creates no posting authority."
  type        = bool
  default     = false
}

variable "social_publisher_host" {
  description = "Retained browser recovery host with its independently pinned accepted image; null explicitly retires it."
  type        = object({ ami_id = string, image = string })
  default     = null
}

locals {
  publisher_environment = var.social_publisher_runtime_ready ? {
    FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN = var.founder_browser.origin
  } : {}
}

resource "terraform_data" "publisher_configuration" {
  input = var.social_publisher_host
  lifecycle {
    precondition {
      condition     = var.social_publisher_host == null || var.founder_browser != null
      error_message = "The isolated publisher requires the existing reviewed browser TLS hostname."
    }
    precondition {
      condition     = !var.social_publisher_runtime_ready || var.founder_browser != null
      error_message = "Buffer media requires the existing canonical public HTTPS app origin."
    }
  }
}

module "social_publisher" {
  source = "../social-publisher"
  # Splat the optional metadata object: presence is known independently of its AMI value.
  count = length(var.social_publisher_host[*])

  name_prefix           = var.name_prefix
  aws_region            = local.aws_region
  aws_account_id        = var.aws_account_id
  vpc_id                = module.network.vpc_id
  subnet_id             = module.network.public_subnet_ids[0]
  alb_security_group_id = module.network.security_group_ids["alb"]
  listener_arn          = module.edge.https_listener_arn
  browser_hostname      = var.founder_browser == null ? "" : split(":", trimprefix(var.founder_browser.origin, "https://"))[0]
  control_secret_arn    = module.secrets.application_secret_arns["social-publisher-control-token"]
  secrets_kms_key_arn   = module.secrets.secrets_kms_key_arn
  ami_id                = var.social_publisher_host.ami_id
  image                 = var.social_publisher_host.image
  tags                  = local.tags

  depends_on = [terraform_data.publisher_configuration]
}

output "social_publisher_instance_id" {
  description = "The isolated host, not proof of account consent or publication readiness."
  value       = one(module.social_publisher[*].instance_id)
}
