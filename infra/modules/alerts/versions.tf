terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    # Zips the digest's two source files (digest.tf). Local only: it reads files and
    # writes a zip, and needs no credential.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
