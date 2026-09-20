provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  # The production root only ever acts as the production deployment role. The
  # rehearsal root assumes a different role whose policy is scoped to fss-rh-*,
  # so a rehearsal teardown has no permission to reach a production resource.
  #
  # The block is present exactly when the caller is not already that role, which
  # locally it is not: David's user assumes `fss-prod-deploy` and the provider is
  # what does the assuming, so `assume_deployment_role` defaults to true and the
  # runbook's section 3.2 commands are unchanged. A session that already holds
  # the role passes false, because assuming a role from itself needs the role to
  # trust itself (Appendix G 39, and
  # `docs/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`).
  #
  # A `dynamic` block rather than `role_arn = … : null`: with the block absent
  # there is nothing to interpret. The AWS provider does accept a null
  # `role_arn` — v5.100.0's schema marks it Optional — but it answers one with a
  # "Missing required argument … will be an error in a future version of the
  # provider" diagnostic, and a credential path that rests on a deprecation is
  # not one to build a release gate on.
  dynamic "assume_role" {
    for_each = var.assume_deployment_role ? [1] : []

    content {
      role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
      session_name = "fss-prod-terraform"
    }
  }

  default_tags {
    tags = {
      Project     = "callie-fss"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

provider "google" {
  project = var.gcp_project_id == "" ? null : var.gcp_project_id
  region  = var.gcp_region
}
