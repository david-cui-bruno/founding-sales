terraform {
  # 1.10 for the S3 native lock file beside the DynamoDB lock table, as in every
  # other root. `import` blocks with an expression `id` need 1.6.
  required_version = ">= 1.10.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    # No AWS provider. This root creates nothing in AWS; its state lives in the
    # production state bucket, and the backend is not a provider.
  }

  # Intentionally unconfigured here. Initialize with
  #   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<production state key arn>"
  backend "s3" {}
}
