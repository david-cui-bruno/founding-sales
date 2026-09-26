terraform {
  # Exactly the version the workflows install (TERRAFORM_VERSION in
  # .github/workflows), which wrote the committed .terraform.lock.hcl. The backend's
  # S3 native lock file needs 1.10 or newer.
  required_version = "1.15.8"

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
