# Issue 473: a rehearsal capacity input cannot alter production topology.
# Offline mocked plans only, with documentation-example account identifiers.

mock_provider "aws" {
  override_during = apply
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/mock/1111111111111111" } }
  mock_resource "aws_lambda_function" { defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:function:mock" } }
  mock_resource "aws_db_instance" { defaults = { arn = "arn:aws:rds:us-east-1:123456789012:db:mock", address = "mock.example.invalid" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-123456" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/fss-rh-diagnostic" } }


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
  environment     = "production"
  name_prefix     = "fss-prod"
  destroyable     = false
  aws_account_id  = "123456789012"
  vpc_cidr        = "10.60.0.0/16"
  certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-4333-8444-555555555555"
  api_hostname    = "production.example.invalid"
  api_image       = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image    = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-prod-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range = { min = 1, max = 4
  }
  worker_schema_range = { min = 1, max = 4
  }
}


run "ordinary_defaults_stay_disabled" {
  command = plan
  assert {
    condition     = output.crm_acquisition_diagnostic == null && length(output.crm_acquisition_diagnostic_witness_policies) == 0
    error_message = "Ordinary production keeps diagnostic configuration absent."
  }
  assert {
    condition     = output.database_name == "fss"
    error_message = "Ordinary database remains fss."
  }
}
run "production_refuses_diagnostic_mode" {
  command = plan
  variables {
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss_diagnostic_fixture" }
  }
  expect_failures = [terraform_data.environment_guard]
}
run "refuses_nonisolated_database" {
  command = plan
  variables {
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss" }
  }
  expect_failures = [var.crm_acquisition_diagnostic]
}
run "isolated_rehearsal_binding" {
  command = apply
  variables {
    environment                = "rehearsal"
    name_prefix                = "fss-rh-diagnostic"
    destroyable                = true
    sending_enabled            = false
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss_diagnostic_fixture" }

  }
  assert {
    condition     = output.database_name == "fss_diagnostic_fixture"
    error_message = "The actual RDS database must use the isolated name."
  }
  assert {
    condition     = jsondecode(output.crm_acquisition_diagnostic.runtime.api_environment.FSS_CRM_ACQUISITION_DIAGNOSTIC).databaseSecretArn == output.crm_acquisition_diagnostic.database_secret_arn && output.crm_acquisition_diagnostic.runtime.api_environment.FSS_DATABASE_NAME == output.database_name && output.crm_acquisition_diagnostic.runtime.worker_environment.FSS_DATABASE_NAME == output.database_name
    error_message = "Startup JSON and API/worker connections bind actual managed outputs."
  }
  assert {
    condition     = alltrue([for env in [output.crm_acquisition_diagnostic.runtime.api_environment, output.crm_acquisition_diagnostic.runtime.worker_environment] : jsondecode(env.FSS_CRM_ACQUISITION_DIAGNOSTIC).databaseInstanceArn == output.crm_acquisition_diagnostic.database_instance_arn && jsondecode(env.FSS_CRM_ACQUISITION_DIAGNOSTIC).ecsClusterArn == output.crm_acquisition_diagnostic.ecs_cluster_arn])
    error_message = "Pre-consent startup must bind the exact actual RDS and ECS resources, not inferred names."
  }
  assert {
    condition     = jsondecode(output.crm_acquisition_diagnostic.runtime.worker_environment.FSS_CRM_ACQUISITION_DIAGNOSTIC).environmentId == output.crm_acquisition_diagnostic.environment_id && output.crm_acquisition_diagnostic.runtime.worker_environment.FSS_SENDING_ENABLED == "false"
    error_message = "Worker shares exact diagnostic UUID and never enables sending."
  }
  assert {
    condition     = output.crm_acquisition_diagnostic.database_tags.CalliePurpose == "acquisition_acceptance" && output.crm_acquisition_diagnostic.database_secret_tags.CallieDiagnosticEnvironment == output.crm_acquisition_diagnostic.environment_id && output.crm_acquisition_diagnostic.runtime.api_tags.CallieDiagnosticEnvironment == output.crm_acquisition_diagnostic.environment_id && output.crm_acquisition_diagnostic.runtime.worker_tags.CalliePurpose == "acquisition_acceptance"
    error_message = "Service tags propagate independent purpose/environment to running tasks."
  }
  assert {
    condition     = length(output.crm_acquisition_diagnostic.witness_policies) == 2 && alltrue([for role, policy in output.crm_acquisition_diagnostic.witness_policies : length(policy.Statement) == 4 && alltrue([for statement in policy.Statement : statement.Effect == "Allow" && (!contains(statement.Resource, "*") || statement.Action == ["ecs:DescribeTaskDefinition"])]) && toset(flatten([for statement in policy.Statement : statement.Action])) == toset(["ecs:DescribeTasks", "ecs:DescribeTaskDefinition", "rds:DescribeDBInstances", "rds:ListTagsForResource", "secretsmanager:DescribeSecret"])])
    error_message = "Only two diagnostic task roles gain the exact readonly witness action set, with Resource=* allowed only for AWS-required DescribeTaskDefinition, and no provider/write/secret-value access."
  }
  assert {
    condition     = alltrue([for role, policy in output.crm_acquisition_diagnostic.witness_policies : policy.Statement[0].Resource[0] == "arn:aws:ecs:us-east-1:123456789012:task/fss-rh-diagnostic-cluster/*" && policy.Statement[1].Resource == ["*"] && policy.Statement[1].Condition.StringEquals["aws:RequestedRegion"] == "us-east-1" && policy.Statement[1].Condition.StringEquals["aws:PrincipalAccount"] == "123456789012" && policy.Statement[0].Condition.StringEquals["ecs:cluster"] == output.crm_acquisition_diagnostic.ecs_cluster_arn && policy.Statement[0].Condition.StringEquals["aws:ResourceTag/CallieDiagnosticEnvironment"] == output.crm_acquisition_diagnostic.environment_id && policy.Statement[2].Resource[0] == output.crm_acquisition_diagnostic.database_instance_arn && policy.Statement[3].Resource[0] == output.crm_acquisition_diagnostic.database_secret_arn])
    error_message = "Witness permissions remain scoped to the current cluster/tag scope, region/account exception, managed RDS and app-runtime secret."
  }
}

run "diagnostic_refuses_sending" {
  command = plan
  variables {
    environment                = "rehearsal"
    name_prefix                = "fss-rh-diagnostic"
    destroyable                = true
    sending_enabled            = true
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss_diagnostic_fixture" }
  }
  expect_failures = [terraform_data.environment_guard]
}
run "diagnostic_refuses_external_database_override" {
  command = plan
  variables {
    environment                = "rehearsal"
    name_prefix                = "fss-rh-diagnostic"
    destroyable                = true
    active_database_host       = "other.example.invalid"
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss_diagnostic_fixture" }
  }
  expect_failures = [terraform_data.environment_guard]
}
run "diagnostic_refuses_ordinary_adapters" {
  command = plan
  variables {
    environment                = "rehearsal"
    name_prefix                = "fss-rh-diagnostic"
    destroyable                = true
    crm_capability_adapters    = "{}"
    crm_acquisition_diagnostic = { environment_id = "11111111-2222-4333-8444-555555555555", database_name = "fss_diagnostic_fixture" }
  }
  expect_failures = [terraform_data.environment_guard]
}
