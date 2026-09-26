# An apply replaces the service task definitions and leaves the running count alone
# (lane g70).
#
# Offline only: mocked applies, no backend, no credentials. Every ARN below is the
# AWS documentation example account, never a real one.
#
# ## Why this file exists
#
# A schema-change release registers task definitions whose strict schema range
# refuses the schema the database is still at. Until 25 September the stop came
# after the apply, inside `infra/scripts/deploy.sh release`, and the apply had
# already pointed the running services at those definitions: the 04:41Z deploy of
# schema 16 ran in that order (`docs/greenfield/release.md` 8.0af). The order is
# now `stop.sh`, then the apply, then `deploy.sh release --schema-change`,
# and it only holds if the apply cannot start what the stop stopped. That is
# `ignore_changes = [desired_count]` on both services.
#
# `lifecycle` is not an attribute a test can read, so these runs are applies with
# state between them and they assert what the lifecycle does, not that it exists:
#
#   1. the stack is created at zero, which is where `stop.sh` leaves a
#      standing one (and where a bootstrap creates a fresh one);
#   2. the release's apply, with the bootstrap off, new images and a new strict
#      range. Without `ignore_changes` this is the apply that set the declared two
#      and one and started tasks that exit 12. With it, both counts stay at zero;
#      the task definitions still carry the new images and ranges and the services
#      still name them, which is the rolling path's half: an ordinary release still
#      rolls the services on to the new revision at whatever count they run.
#
# The declared counts still reach `output.deployment_plan`, because they are what
# `deploy.sh release` scales to after the migration. The vacuous-pass trap is a
# count that stays at zero because nothing declared anything else, so the second
# run asserts the declared numbers too.

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
  api_schema_range          = { min = 15, max = 15 }
  worker_schema_range       = { min = 15, max = 15 }
  api_desired_count         = 2
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

run "the_stack_stands_with_both_services_at_zero" {
  command = apply

  variables {
    bootstrap = true
  }

  # The starting point: both services at zero, as the stop leaves a standing stack
  # and a bootstrap creates a fresh one.
}

run "the_schema_release_apply_moves_the_task_definitions_and_starts_nothing" {
  command = apply

  # Everything a schema-change release changes in this module, and the bootstrap
  # off, which is what a standing environment's apply is.
  variables {
    bootstrap           = false
    api_image           = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-api@sha256:0000000000000000000000000000000000000000000000000000000000000011"
    worker_image        = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-worker@sha256:0000000000000000000000000000000000000000000000000000000000000012"
    api_schema_range    = { min = 16, max = 16 }
    worker_schema_range = { min = 16, max = 16 }
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 0 && aws_ecs_service.worker.desired_count == 0
    error_message = "The apply started a service: its count moved off zero, so tasks whose range refuses the current schema would start before the migration. Both services must carry ignore_changes = [desired_count]."
  }

  # The positive control for the two above: zero is not simply the only number
  # there is. The declared counts are two and one, and they are still what the
  # deploy script scales to once `fss migrate` and `fss verify` have passed.
  assert {
    condition = (output.deployment_plan.api.declared_desired_count == 2
    && output.deployment_plan.worker.declared_desired_count == 1)
    error_message = "The declared counts must still reach deployment_plan: deploy.sh release scales to them after the migration."
  }

  # The rolling half. The lifecycle ignores the count and nothing else: the task
  # definitions carry this release's images and ranges, and each service still
  # names its own, so an ordinary release still rolls on to the new revision.
  assert {
    condition = (jsondecode(aws_ecs_task_definition.api.container_definitions)[0].image == var.api_image
      && jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].image == var.worker_image
    && output.api_environment["FSS_SCHEMA_MIN"] == "16" && output.worker_environment["FSS_SCHEMA_MAX"] == "16")
    error_message = "The apply must still deliver the release's images and schema ranges to both task definitions."
  }

  assert {
    condition = (aws_ecs_service.api.task_definition == aws_ecs_task_definition.api.arn
    && aws_ecs_service.worker.task_definition == aws_ecs_task_definition.worker.arn)
    error_message = "Each service must still name its own task definition, so a new revision reaches it on the apply."
  }
}
