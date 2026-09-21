terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    # For the one wait in this module: a new key's tag has to reach KMS's authorization
    # before RDS may ask to use the key (see main.tf, time_sleep). No cloud call.
    time = {
      source  = "hashicorp/time"
      version = ">= 0.11.0, < 1.0.0"
    }
  }
}
