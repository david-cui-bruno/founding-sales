# The two service task definitions follow the revisions CI registers (lane g91).
#
# Offline only: a mocked plan, no backend, no credentials. Every ARN below is the
# AWS documentation example account, never a real one.
#
# ## Why this file exists
#
# An app-only merge to main is deployed by `.github/workflows/greenfield-deploy.yml`,
# which registers the next revision of each service's running task definition with
# only the image digest changed, and points the service at it. Terraform is not run.
# The next operator plan must not read that as drift to undo, and the next apply that
# does change a definition must still re-point the service. Both hold only if:
#
#   * `aws_ecs_task_definition.api` and `.worker` carry `track_latest = true`, so
#     Terraform reads the family's newest ACTIVE revision — CI's — as its own;
#   * the three one-off definitions do not: CI never registers them, and a one-off
#     that tracked would adopt whatever an operator registered by hand;
#   * the services still name their own definitions' ARNs, with no ignore on
#     `task_definition`, so an apply that registers a revision re-points them.
#
# The vacuous-pass trap is asserting an attribute nobody reads. A mocked plan cannot
# register a revision behind Terraform's back, so this asserts the configuration that
# makes the provider do so, and the positive control is the one-off definitions: the
# same resource type, in the same module, with the attribute false.
#
# The third point is not asserted here, because it cannot be: a mock provider does not
# know which attributes force a replacement, so under it a new image is an in-place
# update that keeps the ARN, and a service that ignored `task_definition` would still
# read as re-pointed. `test/release/ciDeploy.check.ts` reads the two lifecycle blocks
# instead, and fails if either ignores more than `desired_count`.

mock_provider "aws" {
  override_during = apply

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }
}

variables {
  name_prefix               = "fss-test"
  aws_region                = "us-east-1"
  subnet_ids                = ["subnet-1111111111111111a", "subnet-1111111111111111b"]
  api_security_group_ids    = ["sg-1111111111111111a"]
  worker_security_group_ids = ["sg-1111111111111111b"]
  api_image                 = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-api@sha256:0000000000000000000000000000000000000000000000000000000000000001"
  worker_image              = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-worker@sha256:0000000000000000000000000000000000000000000000000000000000000002"
  api_schema_range          = { min = 16, max = 16 }
  worker_schema_range       = { min = 16, max = 16 }
  target_group_arn          = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fss-test-api/1111111111111111"
  api_log_group_name        = "/fss/fss-test/api"
  worker_log_group_name     = "/fss/fss-test/worker"
  metric_namespace          = "FSS/fss-test"

  app_runtime_database_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/app-runtime-database-cccccc"
  migration_database_secret_arn   = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/migration-database-bbbbbb"
  journal_bucket_arn              = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
  journal_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"
  envelope_kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555552"
  secrets_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555553"
}

run "the_two_service_definitions_follow_the_revisions_ci_registers" {
  command = plan

  assert {
    condition     = aws_ecs_task_definition.api.track_latest == true
    error_message = "The API task definition must track its family's newest ACTIVE revision, or the first plan after a CI deploy reads CI's revision as drift and puts the older image back."
  }

  assert {
    condition     = aws_ecs_task_definition.worker.track_latest == true
    error_message = "The worker task definition must track its family's newest ACTIVE revision, for the same reason."
  }
}

run "the_one_off_definitions_stay_terraforms" {
  command = plan

  # The positive control: the same resource type in the same module, and CI never
  # registers any of these three.
  assert {
    # Unset reads as null, and the provider's default is false.
    condition = (coalesce(aws_ecs_task_definition.migration.track_latest, false) == false
      && coalesce(aws_ecs_task_definition.operations.track_latest, false) == false
    && coalesce(aws_ecs_task_definition.drill.track_latest, false) == false)
    error_message = "The migration, operations and drill definitions are Terraform's alone; tracking the latest revision would adopt anything registered in those families by hand."
  }
}
