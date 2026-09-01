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

  # Local backend for now. When ready to move to remote state, create an S3
  # bucket (e.g. callie-sourcing-tfstate-326255650484) + DynamoDB lock table,
  # then uncomment the block below and run `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket         = "callie-sourcing-tfstate-326255650484"
  #   key            = "cloud/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "callie-sourcing-tflock"
  #   encrypt        = true
  # }
}
