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
  }

  # Intentionally unconfigured here. Initialize with
  #   terraform init -backend-config=backend.hcl -backend-config="kms_key_id=<state key arn>"
  # This root's state key is its own: it is neither production's nor any
  # rehearsal run's, so a run that is torn down cannot take the repositories
  # with it and `key=fss/greenfield/rehearsal/<run>/...` can never collide with
  # it whatever the run is called.
  backend "s3" {}
}
