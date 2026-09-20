provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  # The production root only ever acts as the production deployment role. The
  # rehearsal root assumes a different role whose policy is scoped to fss-rh-*,
  # so a rehearsal teardown has no permission to reach a production resource.
  assume_role {
    role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
    session_name = "fss-prod-terraform"
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
