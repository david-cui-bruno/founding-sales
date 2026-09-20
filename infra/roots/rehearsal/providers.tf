provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  assume_role {
    role_arn     = "arn:aws:iam::${var.aws_account_id}:role/${var.deployment_role_name}"
    session_name = "fss-rehearsal-terraform"
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
