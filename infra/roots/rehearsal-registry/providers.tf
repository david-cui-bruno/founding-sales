provider "aws" {
  region              = local.aws_region
  allowed_account_ids = [local.aws_account_id]

  # This root's one apply is a workflow run whose session already is
  # `fss-rh-deploy` (`docs/greenfield/infra-apply-runbook.md` 2.1), so the
  # workflow plans with `-var=assume_deployment_role=false` and the block is not
  # there at all. Assuming the role a second time from itself is what made the
  # G12d plan fail at provider configuration; the answer is this flag, not a
  # trust policy that admits the role to itself.
  # `docs/archive/decisions/g12e-the-provider-does-not-reassume-its-own-session.md`.
  dynamic "assume_role" {
    for_each = var.assume_deployment_role ? [1] : []

    content {
      role_arn     = "arn:aws:iam::${local.aws_account_id}:role/${var.deployment_role_name}"
      session_name = "fss-rehearsal-registry-terraform"
    }
  }

  default_tags {
    tags = {
      Project     = "callie-fss"
      Environment = "rehearsal"
      ManagedBy   = "terraform"
    }
  }
}
