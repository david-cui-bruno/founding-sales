provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  # Preserve legacy worker tags. This root does not load sourcing resources.
  default_tags {
    tags = {
      Project   = "callie-sourcing"
      ManagedBy = "terraform"
    }
  }
}
