provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  # Present only when the caller is not already `fss-rh-deploy`. The release
  # workflow's session is: `aws-actions/configure-aws-credentials` assumed the
  # role through GitHub OIDC before Terraform started, so it passes
  # `-var="assume_deployment_role=false"` and the provider uses the credentials
  # it was given. Assuming the role from a session that is that role needs the
  # role to trust itself, and its trust is the OIDC subject alone (Appendix G
  # 39). The default is true so that a caller who says nothing is refused rather
  # than acting as an ambient credential;
  # `docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  dynamic "assume_role" {
    for_each = var.assume_deployment_role ? [1] : []

    content {
      role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
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

provider "google" {
  project = var.gcp_project_id == "" ? null : var.gcp_project_id
  region  = var.gcp_region
}
