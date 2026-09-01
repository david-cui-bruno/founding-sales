provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  # Shared account: every resource we create must carry these tags.
  default_tags {
    tags = {
      Project   = "callie-sourcing"
      ManagedBy = "terraform"
    }
  }
}
