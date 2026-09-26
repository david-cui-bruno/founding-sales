terraform {
  # Exactly the version the workflows install (TERRAFORM_VERSION in
  # .github/workflows), which wrote the committed .terraform.lock.hcl. The backend's
  # S3 native lock file needs 1.10 or newer.
  required_version = "1.15.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    # No Google provider. A required provider is a configured provider, and a
    # configured Google provider is a Google login every production plan would
    # need; `infra/roots/production-google` requires it instead (lane g85).
  }

  # Intentionally unconfigured here. Initialize with
  #   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"
  # The state key in backend.hcl is the production key and nothing else may use it.
  backend "s3" {}
}
