terraform {
  # 1.10 is the floor because the backend uses the S3 native lock file
  # alongside the DynamoDB lock table, which spec 4.1 requires.
  required_version = ">= 1.10.0"

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
