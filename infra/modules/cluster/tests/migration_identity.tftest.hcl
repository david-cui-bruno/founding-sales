# The migration identity, the runtime identity, and the wall between them (G12h).
#
# David's condition of 21 September: "a distinct migration task role and task
# definition; the runtime task role has no path to DDL credentials; the migration
# user's secret is its own Secrets Manager entry ... readable only by the migration
# role."
#
# Everything below is a *plan* assertion over the policy documents, because that is
# where the boundary either exists or does not. An IAM boundary asserted in prose is a
# boundary nobody checked; these read the JSON.

mock_provider "aws" {
  override_during = plan

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
  api_schema_range          = { min = 1, max = 4 }
  worker_schema_range       = { min = 2, max = 4 }
  target_group_arn          = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fss-test-api/1111111111111111"
  api_log_group_name        = "/fss/fss-test/api"
  worker_log_group_name     = "/fss/fss-test/worker"

  secret_arns = {
    "session-signing-key" = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/session-signing-key-aaaaaa"
  }
  migration_database_secret_arn   = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/migration-database-bbbbbb"
  app_runtime_database_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/app-runtime-database-cccccc"

  journal_bucket_arn   = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
  journal_kms_key_arn  = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"
  envelope_kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555552"
  secrets_kms_key_arn  = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555553"
}

run "eight_identities_and_no_two_of_them_are_the_same" {
  command = plan

  assert {
    condition = length(distinct([
      aws_iam_role.api_task.name,
      aws_iam_role.worker_task.name,
      aws_iam_role.api_execution.name,
      aws_iam_role.worker_execution.name,
      aws_iam_role.migration_task.name,
      aws_iam_role.migration_execution.name,
      aws_iam_role.drill_task.name,
      aws_iam_role.drill_execution.name,
    ])) == 8
    error_message = "The migration identity and the drill identity are each their own task role and execution role, distinct from both services'."
  }

  assert {
    condition     = aws_iam_role.migration_task.name == "fss-test-migration-task" && aws_iam_role.migration_execution.name == "fss-test-migration-exec"
    error_message = "The migration roles carry the environment namespace, so a rehearsal role can never be a production one."
  }
}

# The whole of David's first condition, read out of the policy documents.
run "only_the_migration_execution_role_may_read_the_migration_secret" {
  command = plan

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_execution_secrets.policy).Statement :
      contains(statement.Resource, var.migration_database_secret_arn)
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "The migration execution role is the identity that resolves the DDL credential."
  }

  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_execution_secrets.policy, aws_iam_role_policy.worker_execution_secrets.policy] : [
        for statement in jsondecode(policy).Statement :
        !contains(statement.Resource, var.migration_database_secret_arn)
      ]
    ]))
    error_message = "Neither runtime execution role may resolve the migration user's credential. That is the path to DDL David's condition removes."
  }

  # And no task definition a *service* uses carries it either, which is the same
  # rule read from the other end: an execution role that could not resolve it is
  # only half the answer if a definition still names it.
  assert {
    condition = alltrue(flatten([
      for definitions in [
        jsondecode(aws_ecs_task_definition.api.container_definitions),
        jsondecode(aws_ecs_task_definition.worker.container_definitions),
        jsondecode(aws_ecs_task_definition.operations.container_definitions),
        ] : [
        for container in definitions : [
          for reference in container.secrets : reference.valueFrom != var.migration_database_secret_arn
        ]
      ]
    ]))
    error_message = "No service task definition, and not the operations one either, may reference the migration entry."
  }

  # And the boundary is symmetric on the other side: the migration identity holds
  # exactly the two database entries and none of the application secrets. A
  # migration task that could read the Gmail client is a migration task that could
  # send mail if the image ever grew a way to.
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_execution_secrets.policy).Statement :
      length(setsubtract(toset(statement.Resource), toset([var.migration_database_secret_arn, var.app_runtime_database_secret_arn]))) == 0
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "The migration execution role reads the two database entries and nothing else. It reads the runtime entry because `fss admin database-users ensure` is what sets that password."
  }
}

# Nothing in the cluster reads the RDS-managed master secret any more. It is the
# operator's, used once from his own machine to fill `migration-database`, and a
# service that could read it would still hold DDL whatever the rest of this says.
run "nothing_in_the_cluster_reads_the_rds_managed_master_secret" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for policy in [
        aws_iam_role_policy.api_execution_secrets.policy,
        aws_iam_role_policy.worker_execution_secrets.policy,
        aws_iam_role_policy.migration_execution_secrets.policy,
        ] : [
        for statement in jsondecode(policy).Statement : [
          for resource in statement.Resource : !can(regex("rds!db", resource))
        ]
      ]
    ]))
    error_message = "The RDS-managed master secret is not an identity any task may assume the value of."
  }

  assert {
    condition     = join(",", output.secret_environment_names) == "DATABASE_SECRET_ARN,session-signing-key"
    error_message = "The services resolve their database credential from the app_runtime entry, beside the application secrets."
  }
}

# The task role is the application identity, and `fss migrate` needs nothing but
# PostgreSQL. No journal, no envelope key, no bucket: a role that can reach them is a
# role a mistake can reach them through.
run "the_migration_task_role_reaches_nothing_but_the_database" {
  command = plan

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_task.policy).Statement :
      alltrue([for action in statement.Action : !startswith(action, "s3:")])
    ])
    error_message = "The migration task role has no S3 reach at all, including the suppression journal."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_task.policy).Statement :
      !contains(statement.Resource, var.journal_kms_key_arn) && !contains(statement.Resource, var.envelope_kms_key_arn)
    ])
    error_message = "The migration task role holds neither the journal key nor the envelope key that unwraps mailbox refresh tokens."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_task.policy).Statement :
      statement.Condition.StringEquals["cloudwatch:namespace"] == "FSS"
      if contains(statement.Action, "cloudwatch:PutMetricData")
    ])
    error_message = "The one thing it may do outside PostgreSQL is publish its own metrics, in the FSS namespace."
  }
}

# The task definition. Same image and same digest as the worker, because the whole
# point of running the migration from the worker image is that it is the code that is
# about to run against the schema it applies.
run "the_migration_task_definition_is_the_worker_image_under_the_migration_identity" {
  command = plan

  assert {
    condition     = aws_ecs_task_definition.migration.family == "fss-test-migration"
    error_message = "The migration task definition is its own family."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].image == var.worker_image
    error_message = "The migration task runs the worker image at the release digest, not some other artifact."
  }

  assert {
    condition     = aws_ecs_task_definition.migration.task_role_arn == aws_iam_role.migration_task.arn
    error_message = "The migration task definition carries the migration task role."
  }

  assert {
    condition     = aws_ecs_task_definition.migration.execution_role_arn == aws_iam_role.migration_execution.arn
    error_message = "The migration task definition carries the migration execution role, which is what resolves the DDL credential."
  }

  # `command` is appended to the image's ENTRYPOINT, which is the worker's
  # `bootstrap/main.ts`. So the entry point is replaced here rather than overridden at
  # run time: `aws ecs run-task --overrides` can replace a command and cannot replace
  # an entry point, and a task definition that expected otherwise would start a
  # *worker* every time somebody asked it for a migration.
  assert {
    condition     = jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].entryPoint == ["node", "apps/worker/src/tools/fss.ts"]
    error_message = "The migration container's entry point is the operations command line, because a run-task override cannot replace an entry point."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].command == ["migrate"]
    error_message = "Its default command is `fss migrate`; every other use is an explicit override."
  }

  # The names the tool actually reads (`TOOL_ENVIRONMENT_VARIABLES` and
  # `RUNTIME_SECRET_VARIABLE`). `fss migrate` never falls back to the runtime
  # connection, so this definition carries no `DATABASE_SECRET_ARN` at all: a
  # migration applied with the application's credential is not a mistake that can
  # be made from here.
  assert {
    condition = length(setsubtract(
      toset([for reference in jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].secrets : reference.name]),
      toset(["MIGRATION_DATABASE_SECRET", "FSS_RUNTIME_DATABASE_SECRET_ARN"]),
    )) == 0
    error_message = "The migration task carries the migration credential and the runtime entry's value, and no runtime connection."
  }

  # A migration is not a long-lived service and must never be restarted by a health
  # check: it runs once, exits, and the wrapper reads the exit code.
  assert {
    condition     = !can(jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].healthCheck)
    error_message = "A one-off task has no health check; its exit code is the answer."
  }
}

# `fss verify` and `fss drill` run as the *runtime* identity on purpose: the point of
# a post-deploy gate is to prove the credential the services will use actually reaches
# the database, and the drill needs the journal and the envelope key the migration
# role must not have.
run "the_operations_task_definition_is_the_runtime_identity_with_the_tool_as_its_entry_point" {
  command = plan

  assert {
    condition     = aws_ecs_task_definition.operations.task_role_arn == aws_iam_role.worker_task.arn
    error_message = "`fss verify` and `fss drill` run as the worker task role, so a verify that passes proves the runtime identity reaches the database."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.operations.container_definitions)[0].entryPoint == ["node", "apps/worker/src/tools/fss.ts"]
    error_message = "The operations container's entry point is the tool."
  }

  assert {
    condition = alltrue([
      for secret in jsondecode(aws_ecs_task_definition.operations.container_definitions)[0].secrets :
      secret.valueFrom != var.migration_database_secret_arn
    ])
    error_message = "The operations task holds the runtime credential, never the migration one."
  }
}

# `fss drill` is the one command that needs both, so it is the one identity that has
# both — and it is neither of the other two.
run "the_drill_is_its_own_identity_because_it_needs_the_journal_and_the_migration_credential" {
  command = plan

  assert {
    condition     = aws_ecs_task_definition.drill.task_role_arn == aws_iam_role.drill_task.arn
    error_message = "The drill runs as its own task role, not the worker's and not the migration's."
  }

  assert {
    condition = length(setsubtract(
      toset(["DATABASE_SECRET_ARN", "MIGRATION_DATABASE_SECRET"]),
      toset([for reference in jsondecode(aws_ecs_task_definition.drill.container_definitions)[0].secrets : reference.name]),
    )) == 0
    error_message = "Appendix E steps 2 to 6 are the application's work and step 7 is DDL, so the drill carries both connections."
  }

  # Read, never write. A drill that could append to the journal could manufacture
  # the evidence step 2 is checked against.
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.drill_task.policy).Statement :
      alltrue([for action in statement.Action : action != "s3:PutObject" && !startswith(action, "s3:Delete")])
    ])
    error_message = "The drill task role reads the suppression journal and never writes it."
  }

  # `recorded`, fixed in the definition. A rehearsal that reached a real mailbox
  # would send real mail, and a mode the caller passes is a mode the caller can
  # forget (David's condition 6).
  assert {
    condition = length([
      for variable in jsondecode(aws_ecs_task_definition.drill.container_definitions)[0].environment :
      variable if variable.name == "FSS_DEPENDENCIES" && variable.value == "recorded"
    ]) == 1
    error_message = "The drill task definition fixes FSS_DEPENDENCIES=recorded; reconcile-sent, recover and watch-renew all reach Gmail when it is live."
  }

  # And the worker service does not inherit that. The drill's mode is set on the
  # drill's definition alone; a `recorded` leaking into the service would be a
  # rehearsal deploying something other than what production deploys.
  assert {
    condition     = !contains(keys(output.worker_environment), "FSS_DEPENDENCIES")
    error_message = "The worker service's dependency mode comes from the root (var.environment), never from the drill's definition."
  }
}

# Bootstrap. A fresh environment creates both services at zero and is scaled by
# `infra/scripts/release-deploy.sh` after the migration task and `fss verify` succeed.
run "a_bootstrap_apply_creates_both_services_at_zero" {
  command = plan

  variables {
    bootstrap            = true
    api_desired_count    = 2
    worker_desired_count = 1
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 0 && aws_ecs_service.worker.desired_count == 0
    error_message = "On a fresh environment nothing starts before the migration has run: both services are created at desired count zero."
  }

  # The declared count survives the bootstrap. The scale-up target is read from this
  # output rather than typed into the script, so a root that asks for two API tasks
  # gets two and the two places cannot disagree.
  assert {
    condition     = output.deployment_plan.bootstrap && output.deployment_plan.api.declared_desired_count == 2 && output.deployment_plan.worker.declared_desired_count == 1
    error_message = "The deployment plan reports what the services are for and what they are right now, separately."
  }

  assert {
    condition     = output.deployment_plan.api.planned_desired_count == 0 && output.deployment_plan.worker.planned_desired_count == 0
    error_message = "The planned count is read back from the service resource, not echoed from the variable."
  }
}

run "an_ordinary_apply_creates_the_services_at_their_declared_count" {
  command = plan

  variables {
    bootstrap            = false
    api_desired_count    = 2
    worker_desired_count = 1
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 2 && aws_ecs_service.worker.desired_count == 1
    error_message = "Outside a bootstrap Terraform declares the real counts, so the scale-up the script performs is reconciled rather than drifted."
  }

  assert {
    condition     = output.deployment_plan.bootstrap == false
    error_message = "The plan says which of the two states this apply is."
  }
}
