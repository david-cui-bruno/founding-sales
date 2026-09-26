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
    # configured Google provider is a credential CI does not have.
  }

  # Intentionally unconfigured here. CI initializes one state object per run:
  #   terraform init -backend-config=backend.hcl \
  #     -backend-config="key=fss/greenfield/rehearsal/${RUN_ID}/terraform.tfstate" \
  #     -backend-config="kms_key_id=<state key arn>"
  backend "s3" {}
}
