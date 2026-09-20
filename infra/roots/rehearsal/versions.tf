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

  # Intentionally unconfigured here. CI initializes one state object per run:
  #   terraform init -backend-config=backend.hcl \
  #     -backend-config="key=fss/greenfield/rehearsal/${RUN_ID}/terraform.tfstate" \
  #     -backend-config="kms_key_id=<state key arn>"
  backend "s3" {}
}
