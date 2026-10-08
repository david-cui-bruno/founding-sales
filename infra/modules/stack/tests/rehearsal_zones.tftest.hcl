# Issue 473: a rehearsal capacity input cannot alter production topology.
# Offline mocked plans only, with documentation-example account identifiers.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555555"
      key_id = "11111111-2222-4333-8444-555555555555"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn                         = "arn:aws:s3:::mock-bucket"
      id                          = "mock-bucket"
      bucket_regional_domain_name = "mock-bucket.s3.us-east-1.amazonaws.com"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/mock/1111111111111111"
      dns_name = "mock-1111111111.us-east-1.elb.amazonaws.com"
      zone_id  = "Z35SXDOTRQ7X7K"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:123456789012:mock-alerts"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      arn         = "arn:aws:cloudfront::123456789012:distribution/E111111111111"
      id          = "E111111111111"
      domain_name = "d111111111111.cloudfront.net"
    }
  }
}

variables {
  environment         = "production"
  name_prefix         = "fss-prod"
  destroyable         = false
  aws_account_id      = "123456789012"
  vpc_cidr            = "10.60.0.0/16"
  certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname        = "production.example.invalid"
  api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range    = { min = 1, max = 4 }
  worker_schema_range = { min = 1, max = 4 }
}

run "production_keeps_its_fixed_zone_pair" {
  command = plan

  assert {
    condition     = join(",", output.availability_zones) == "us-east-1a,us-east-1b"
    error_message = "Production's actual private database subnets stay in a/b."
  }
}

run "production_refuses_an_alternate_rehearsal_override" {
  command = plan

  variables {
    rehearsal_availability_zones = ["us-east-1a", "us-east-1d"]
  }

  expect_failures = [terraform_data.environment_guard]
}

run "the_shared_stack_refuses_foreign_rehearsal_zones" {
  command = plan

  variables {
    environment                  = "rehearsal"
    name_prefix                  = "fss-rh-capacity"
    destroyable                  = true
    rehearsal_availability_zones = ["us-west-2a", "us-west-2b"]
  }

  expect_failures = [var.rehearsal_availability_zones]
}

run "the_shared_stack_refuses_duplicate_rehearsal_zones" {
  command = plan

  variables {
    environment                  = "rehearsal"
    name_prefix                  = "fss-rh-capacity"
    destroyable                  = true
    rehearsal_availability_zones = ["us-east-1a", "us-east-1a"]
  }

  expect_failures = [var.rehearsal_availability_zones]
}
