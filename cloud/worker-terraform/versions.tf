terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Intentionally unconfigured. Review README.md and backend.hcl.example first.
  # No backend resources are created here. Never reuse the sourcing state key.
  backend "s3" {}
}
