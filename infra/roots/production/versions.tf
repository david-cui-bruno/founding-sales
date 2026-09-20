terraform {
  # 1.10 is the floor because the backend uses the S3 native lock file
  # alongside the DynamoDB lock table, which spec 4.1 requires.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Intentionally unconfigured here. Initialize with
  #   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"
  # The state key in backend.hcl is the production key and nothing else may use it.
  backend "s3" {}
}
