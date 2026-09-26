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
  override_during = apply

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock"
      id  = "mock"
    }
  }
}

# The provider mock gives every `aws_iam_role` the same ARN, which would make any
# "this definition carries that role" comparison true whichever role it actually
# referenced. These three give the roles the assertions name an ARN of their own,
# so the last run in this file can fail. Like the provider mock they take effect
# during the apply phase, which is why that run is an apply run.
override_resource {
  target = aws_iam_role.migration_task
  values = {
    arn = "arn:aws:iam::123456789012:role/fss-test-migration-task"
  }
}

override_resource {
  target = aws_iam_role.migration_execution
  values = {
    arn = "arn:aws:iam::123456789012:role/fss-test-migration-exec"
  }
}

override_resource {
  target = aws_iam_role.worker_task
  values = {
    arn = "arn:aws:iam::123456789012:role/fss-test-worker-task"
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
  metric_namespace          = "FSS/fss-test"

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

run "six_identities_and_only_the_migration_one_reaches_the_ddl_credential" {
  command = plan

  assert {
    condition = length(distinct([
      aws_iam_role.api_task.name,
      aws_iam_role.worker_task.name,
      aws_iam_role.api_execution.name,
      aws_iam_role.worker_execution.name,
      aws_iam_role.migration_task.name,
      aws_iam_role.migration_execution.name,
    ])) == 6
    error_message = "The migration identity is its own task role and execution role, distinct from both services'."
  }

  # The migration execution role resolves the migration entry and the runtime entry
  # (`fss admin database-users ensure` sets that password), and nothing else: a
  # migration task that could read the Gmail client could send mail if the image
  # ever grew a way to.
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_execution_secrets.policy).Statement :
      contains(statement.Resource, var.migration_database_secret_arn)
      && length(setsubtract(toset(statement.Resource), toset([var.migration_database_secret_arn, var.app_runtime_database_secret_arn]))) == 0
      if contains(statement.Action, "secretsmanager:GetSecretValue")
    ])
    error_message = "The migration execution role reads the two database entries and nothing else."
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

  # The same rule read from the other end: no definition a service or the
  # operations tool uses names the migration entry.
  assert {
    condition = alltrue(flatten([
      for definition in [aws_ecs_task_definition.api, aws_ecs_task_definition.worker, aws_ecs_task_definition.operations] : [
        for reference in jsondecode(definition.container_definitions)[0].secrets : reference.valueFrom != var.migration_database_secret_arn
      ]
    ]))
    error_message = "No service task definition, and not the operations one either, may reference the migration entry."
  }

  # The RDS-managed master secret is the operator's, used once from his own machine.
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
    error_message = "No task may resolve the RDS-managed master secret."
  }

  # `fss migrate` needs nothing but PostgreSQL.
  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_role_policy.migration_task.policy).Statement :
      alltrue([for action in statement.Action : !startswith(action, "s3:")])
      && !contains(statement.Resource, var.journal_kms_key_arn) && !contains(statement.Resource, var.envelope_kms_key_arn)
    ])
    error_message = "The migration task role has no S3 reach and holds neither the journal key nor the envelope key."
  }

  # The worker image at the release digest, carrying the migration credential and
  # the runtime entry's value and no runtime connection: a migration applied with
  # the application's credential is not a mistake that can be made from here.
  assert {
    condition = (jsondecode(aws_ecs_task_definition.migration.container_definitions)[0].image == var.worker_image
    && output.task_secret_names.migration == tolist(["FSS_RUNTIME_DATABASE_SECRET_ARN", "MIGRATION_DATABASE_SECRET"]))
    error_message = "The migration task runs the worker image with the migration credential and no runtime connection."
  }
}

# A fresh environment creates both services at zero; the deploy script scales them
# to the declared counts after the migration task and `fss verify` succeed.
run "a_bootstrap_apply_creates_both_services_at_zero" {
  command = plan

  variables {
    bootstrap         = true
    api_desired_count = 2
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 0 && aws_ecs_service.worker.desired_count == 0
    error_message = "On a fresh environment nothing starts before the migration has run."
  }

  assert {
    condition     = output.deployment_plan.bootstrap && output.deployment_plan.api.declared_desired_count == 2 && output.deployment_plan.worker.declared_desired_count == 1
    error_message = "The declared counts survive the bootstrap: they are what the deploy script scales to."
  }
}

run "an_ordinary_apply_creates_the_services_at_their_declared_count" {
  command = plan

  variables {
    bootstrap         = false
    api_desired_count = 2
  }

  assert {
    condition     = aws_ecs_service.api.desired_count == 2 && aws_ecs_service.worker.desired_count == 1
    error_message = "Outside a bootstrap Terraform declares the real counts."
  }
}

# Role ARNs are computed, so this is a mocked apply; the three override_resource
# blocks above give the roles ARNs of their own, so a definition that referenced
# the wrong role fails rather than passing on a shared mock default
# (docs/archive/decisions/g12j-mock-providers-keep-computed-values-unknown.md).
run "each_one_off_task_definition_carries_the_identity_it_is_for" {
  command = apply

  assert {
    condition = (aws_ecs_task_definition.migration.task_role_arn == aws_iam_role.migration_task.arn
    && aws_ecs_task_definition.migration.execution_role_arn == aws_iam_role.migration_execution.arn)
    error_message = "The migration task definition carries the migration task and execution roles."
  }

  assert {
    condition     = aws_ecs_task_definition.operations.task_role_arn == aws_iam_role.worker_task.arn
    error_message = "`fss verify` runs as the worker task role, so a verify that passes proves the runtime identity reaches the database."
  }
}

# Lane g81, audit S17: each task definition carries the application secrets its own
# process reads and no others.
run "each_task_definition_carries_only_the_secrets_its_process_reads" {
  command = plan

  variables {
    secret_arns = {
      "device-credential-pepper"  = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/device-credential-pepper-dddddd"
      "google-gmail-oauth-client" = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/google-gmail-oauth-client-eeeeee"
      "google-oidc-client"        = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/google-oidc-client-ffffff"
      "llm-classifier-api-key"    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/llm-classifier-api-key-gggggg"
      "session-signing-key"       = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/session-signing-key-aaaaaa"
    }
  }

  assert {
    condition = (
      output.task_secret_names.api == tolist(["DATABASE_SECRET_ARN", "device-credential-pepper", "google-gmail-oauth-client", "google-oidc-client", "session-signing-key"])
      && output.task_secret_names.worker == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client"])
      && output.task_secret_names.operations == tolist(["DATABASE_SECRET_ARN", "google-gmail-oauth-client"])
    )
    error_message = "The API gets its sign-in and session material; the worker and the operations tool the Gmail client."
  }

  assert {
    condition = alltrue(flatten([
      for definition in [aws_ecs_task_definition.worker, aws_ecs_task_definition.operations] : [
        for reference in jsondecode(definition.container_definitions)[0].secrets :
        !contains(["session-signing-key", "device-credential-pepper", "google-oidc-client"], reference.name)
      ]
    ]))
    error_message = "The session-signing key, the device-credential pepper and the sign-in client are the API's alone."
  }
}

# Lane g81: the classifier reads FSS_LLM_CLASSIFIER_API_KEY, and only the worker runs it.
run "the_worker_reads_the_classifier_key_under_the_name_the_classifier_reads" {
  command = plan

  variables {
    worker_reads_classifier_key = true
    secret_arns = {
      "google-gmail-oauth-client" = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/google-gmail-oauth-client-eeeeee"
      "llm-classifier-api-key"    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/llm-classifier-api-key-gggggg"
      "session-signing-key"       = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/session-signing-key-aaaaaa"
    }
  }

  assert {
    condition = [
      for reference in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets :
      reference.valueFrom if reference.name == "FSS_LLM_CLASSIFIER_API_KEY"
    ] == ["arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/llm-classifier-api-key-gggggg"]
    error_message = "FSS_LLM_CLASSIFIER_API_KEY resolves from the llm-classifier-api-key entry on the worker."
  }

  assert {
    condition = alltrue(flatten([
      for definition in [aws_ecs_task_definition.api, aws_ecs_task_definition.operations] : [
        for reference in jsondecode(definition.container_definitions)[0].secrets :
        reference.name != "FSS_LLM_CLASSIFIER_API_KEY"
      ]
    ]))
    error_message = "Only the worker runs classify.reply, so only the worker holds the classifier key."
  }
}

run "a_secret_no_process_reads_is_refused" {
  command = plan

  variables {
    secret_arns = {
      "session-signing-key" = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/session-signing-key-aaaaaa"
      "unclaimed-secret"    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/unclaimed-secret-iiiiii"
    }
  }

  expect_failures = [aws_ecs_task_definition.api]
}
