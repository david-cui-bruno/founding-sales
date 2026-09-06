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

  # Configuration is supplied from backend.hcl only after both Hold Point 1
  # confirmations. Source verification does not initialize this backend.
  backend "s3" {}
}
