# Runtime secret values are created only through the separately confirmed
# Hold Point 1 operator workflow. Terraform owns the encryption key and passes
# only public parameter identifiers to Lambda configuration.
resource "aws_kms_key" "runtime_secrets" {
  description             = "KMS key for callie-sourcing runtime SecureString parameters"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "runtime_secrets" {
  name          = "alias/${var.name_prefix}-runtime-secrets"
  target_key_id = aws_kms_key.runtime_secrets.key_id
}

locals {
  tracerfy_api_key_parameter_name = "/callie-sourcing/tracerfy-api-key"
  ntfy_topic_parameter_name       = "/callie-sourcing/ntfy-topic"
  hmac_salt_parameter_name        = "/callie-sourcing/membership-hmac-salt"
}
