provider "aws" {
  region              = local.aws_region
  allowed_account_ids = [local.aws_account_id]

  # Present only when the caller is not already `fss-rh-deploy`. The release
  # workflow's session is: `aws-actions/configure-aws-credentials` assumed the
  # role through GitHub OIDC before Terraform started, so it passes
  # `-var="assume_deployment_role=false"` and the provider uses the credentials
  # it was given. Assuming the role from a session that is that role needs the
  # role to trust itself, and its trust is the OIDC subject alone (Appendix G
  # 39). The default is true so that a caller who says nothing is refused rather
  # than acting as an ambient credential;
  # `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  dynamic "assume_role" {
    for_each = var.assume_deployment_role ? [1] : []

    content {
      role_arn     = "arn:aws:iam::${local.aws_account_id}:role/${local.deployment_role_name}"
      session_name = "fss-rehearsal-terraform"
    }
  }

  default_tags {
    tags = {
      Project     = "callie-fss"
      Environment = "rehearsal"
      ManagedBy   = "terraform"
      Ephemeral   = "true"
    }
  }
}

# There is no `provider "google"` here.
#
# Terraform configures every provider a root requires before it plans anything,
# so declaring one is asking for its credential. CI has no Google credential and
# must not have one: the rehearsal's Gmail is the recorded fake, and the topic
# and subscription belong to `infra/roots/production` alone.
# `docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`.
