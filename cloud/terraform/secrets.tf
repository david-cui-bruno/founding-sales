# Hold Point 1 creates and verifies this key before any parameter or Lambda
# cutover. Terraform consumes the stable alias only after prevalidation.
data "aws_kms_alias" "runtime_secrets" {
  name = "alias/${var.name_prefix}-runtime-secrets"
}

locals {
  tracerfy_api_key_parameter_name = "/callie-sourcing/tracerfy-api-key"
  ntfy_topic_parameter_name       = "/callie-sourcing/ntfy-topic"
  hmac_salt_parameter_name        = "/callie-sourcing/membership-hmac-salt"
}
