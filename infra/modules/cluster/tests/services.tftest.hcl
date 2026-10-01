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
  api_schema_range          = { min = 1, max = 4 }
  worker_schema_range       = { min = 2, max = 4 }
  target_group_arn          = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/fss-test-api/1111111111111111"
  api_log_group_name        = "/fss/fss-test/api"
  worker_log_group_name     = "/fss/fss-test/worker"
  metric_namespace          = "FSS/fss-test"

  app_runtime_database_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/app-runtime-database-cccccc"
  migration_database_secret_arn   = "arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-test/migration-database-bbbbbb"
  journal_bucket_arn              = "arn:aws:s3:::fss-test-suppression-journal-123456789012"
  call_audio_bucket_arn           = "arn:aws:s3:::fss-test-call-audio-123456789012"
  aws_account_id                  = "123456789012"
  journal_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555551"
  envelope_kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555552"
  secrets_kms_key_arn             = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-4333-8444-555555555553"
}

run "separate_roles_an_append_only_journal_and_one_metric_namespace" {
  command = plan

  assert {
    condition = length(distinct([
      aws_iam_role.api_task.name,
      aws_iam_role.worker_task.name,
      aws_iam_role.api_execution.name,
      aws_iam_role.worker_execution.name,
    ])) == 4
    error_message = "API and worker each have their own task role and their own execution role."
  }

  # Specification 10.2: both processes journal suppressions before acknowledging
  # (the API from its write routes, the worker from mail sync), on the journal
  # object prefix only. A put granted on "*" would be a task that can write any
  # bucket in the account.
  assert {
    condition = alltrue([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] :
      [
        for statement in jsondecode(policy).Statement : statement.Resource
        # Slice C3a's call-audio bucket is the worker's other put, asserted below.
        if contains(statement.Action, "s3:PutObject") && statement.Resource != ["arn:aws:s3:::fss-test-call-audio-123456789012/calls/*"]
      ] == [["arn:aws:s3:::fss-test-suppression-journal-123456789012/*"]]
    ])
    error_message = "Both task roles append to the journal, and only on its object prefix."
  }

  # An append-only journal one of its writers can erase or unlock is not one.
  assert {
    condition = alltrue(flatten([
      for policy in [aws_iam_role_policy.api_task.policy, aws_iam_role_policy.worker_task.policy] : [
        for statement in jsondecode(policy).Statement : [
          for action in statement.Action :
          !startswith(action, "s3:Delete") && !contains(["s3:PutObjectRetention", "s3:PutObjectLegalHold", "s3:BypassGovernanceRetention"], action)
        ]
        # The one delete either role holds is the worker's, on slice C3a's call audio
        # (asserted to be exactly that below), never on the journal.
        if statement.Resource != ["arn:aws:s3:::fss-test-call-audio-123456789012/calls/*"]
      ]
    ]))
    error_message = "Neither task role may delete from the journal or weaken an object lock."
  }

  # g42, lane g55: a rehearsal and production share an account, so a task that
  # could publish into another environment's namespace would feed its alarms.
  assert {
    condition = alltrue([
      for policy in [
        aws_iam_role_policy.api_task.policy,
        aws_iam_role_policy.worker_task.policy,
        aws_iam_role_policy.migration_task.policy,
        ] : [
        for statement in jsondecode(policy).Statement :
        statement.Condition.StringEquals["cloudwatch:namespace"]
        if contains(statement.Action, "cloudwatch:PutMetricData")
      ] == ["FSS/fss-test"]
    ])
    error_message = "Every task role that may publish metrics may publish only into this environment's namespace."
  }
}

# Slice C3a: the worker stages call audio for Amazon Transcribe and follows its jobs —
# objects under calls/ only, a job only when it writes its output to that bucket under
# calls/, and only this stack's jobs by name. The API may only delete those objects.
run "the_worker_alone_may_stage_call_audio_and_run_this_stacks_transcription_jobs" {
  command = plan

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement : statement
      if anytrue([for resource in statement.Resource : startswith(resource, "arn:aws:s3:::fss-test-call-audio-")])
      ] == [{
        Sid      = "StageCallAudioForTranscription"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::fss-test-call-audio-123456789012/calls/*"]
    }]
    error_message = "The worker may put, get and delete call audio under calls/ only, and do nothing else in that bucket."
  }

  assert {
    condition = (
      [
        for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement : statement.Resource
        if contains(statement.Action, "transcribe:GetTranscriptionJob")
      ] == [["arn:aws:transcribe:us-east-1:123456789012:transcription-job/fss-test-*"]]
      && [
        for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement : statement.Condition
        if contains(statement.Action, "transcribe:StartTranscriptionJob")
        ] == [{
          StringEquals = { "transcribe:OutputBucketName" = "fss-test-call-audio-123456789012" }
          StringLike   = { "transcribe:OutputKey" = "calls/*" }
      }]
      && !strcontains(aws_iam_role_policy.worker_task.policy, "transcribe:DeleteTranscriptionJob")
    )
    error_message = "Get names this stack's jobs; Start (no resource type) only when the job writes its output to the call-audio bucket under calls/; no job delete."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.api_task.policy).Statement : statement
      if strcontains(jsonencode(statement), "call-audio") || anytrue([for action in statement.Action : startswith(action, "transcribe:")])
      ] == [{
        Sid      = "DeleteDeletedCallsAudio"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject"]
        Resource = ["arn:aws:s3:::fss-test-call-audio-123456789012/calls/*"]
    }]
    error_message = "The API task role may only delete call audio under calls/ (the deletion workflow), and reaches no Transcribe action."
  }

  assert {
    condition     = output.api_environment["FSS_CALL_AUDIO_BUCKET"] == "fss-test-call-audio-123456789012"
    error_message = "The API is told the call-audio bucket, for the deletion workflow's delete."
  }
}

run "the_containers_get_their_ranges_arm64_and_no_secret_by_value" {
  command = plan

  assert {
    condition = (output.api_environment["FSS_SCHEMA_MIN"] == "1" && output.api_environment["FSS_SCHEMA_MAX"] == "4"
    && output.worker_environment["FSS_SCHEMA_MIN"] == "2" && output.worker_environment["FSS_SCHEMA_MAX"] == "4")
    error_message = "Each binary is told the schema range it declares."
  }

  assert {
    condition = (contains(output.task_secret_names.api, "DATABASE_SECRET_ARN")
      && length([
        for name, value in output.api_environment : name
        if can(regex("(?i)(password|secret|token|credential|private_key)", name))
    ]) == 0)
    error_message = "Database credentials arrive as a Secrets Manager reference, and no environment name looks like a credential."
  }

  # The images are linux/arm64 only; see the note at the top of main.tf.
  assert {
    condition = alltrue([
      for definition in [
        aws_ecs_task_definition.api,
        aws_ecs_task_definition.worker,
        aws_ecs_task_definition.migration,
        aws_ecs_task_definition.operations,
      ] : definition.runtime_platform[0].cpu_architecture == "ARM64" && definition.runtime_platform[0].operating_system_family == "LINUX"
    ])
    error_message = "Every task definition asks Fargate for ARM64 Linux, the only platform the images are built for."
  }
}

# `api_environment` and `worker_environment` are each one task's alone. The
# operations definition is built from the worker's, by construction, so what the
# worker is told the operations tool is told too.
run "a_worker_only_variable_reaches_the_worker_and_not_the_api" {
  command = plan

  variables {
    worker_environment = { FSS_WORKER_CONCURRENCY = "3" }
  }

  assert {
    condition = (
      output.worker_environment["FSS_WORKER_CONCURRENCY"] == "3"
      && !contains(keys(output.api_environment), "FSS_WORKER_CONCURRENCY")
      && output.worker_environment["FSS_ROLE"] == "worker"
    )
    error_message = "A worker-only environment variable reaches the worker task and no other, and cannot displace FSS_ROLE."
  }
}

run "the_bare_fss_namespace_is_refused" {
  command = plan

  variables {
    metric_namespace = "FSS"
  }

  expect_failures = [var.metric_namespace]
}

run "a_mutable_image_tag_is_refused" {
  command = plan

  variables {
    api_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/fss-test-api:latest"
  }

  expect_failures = [var.api_image]
}

run "an_inverted_schema_range_is_refused" {
  command = plan

  variables {
    worker_schema_range = { min = 5, max = 4 }
  }

  expect_failures = [var.worker_schema_range]
}

# Slice BR1: with the Bedrock transport the worker may invoke exactly the US inference
# profiles the code maps, the foundation models they route to only through those profiles,
# and count tokens on the one model that answers it. Nothing else of Bedrock, and nothing
# of it for the API.
run "the_bedrock_worker_invokes_only_the_mapped_profiles_and_their_routed_models" {
  command = plan

  variables {
    worker_model_transport = "bedrock"
  }

  assert {
    condition     = output.worker_environment["FSS_MODEL_TRANSPORT"] == "bedrock"
    error_message = "A Bedrock worker is told so, under the variable the code reads."
  }

  assert {
    condition = [
      for statement in jsondecode(aws_iam_role_policy.worker_task.policy).Statement : statement
      if anytrue([for action in statement.Action : startswith(action, "bedrock:")])
      ] == [
      {
        Sid    = "InvokeClaudeThroughUsInferenceProfiles"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        ]
      },
      {
        Sid    = "InvokeTheModelsThoseProfilesRouteTo"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
          "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
          "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        ]
        Condition = { StringEquals = { "bedrock:InferenceProfileArn" = [
          "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        ] } }
      },
      {
        Sid      = "CountTokensBeforeResearchCalls"
        Effect   = "Allow"
        Action   = ["bedrock:CountTokens"]
        Resource = ["arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"]
      },
    ]
    error_message = "The worker's Bedrock grant is InvokeModel on the Haiku 4.5 US profile, on their routed models only through them, and CountTokens on Haiku 4.5 here."
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.api_task.policy, "bedrock:")
    error_message = "The API makes no model call and is granted nothing of Bedrock."
  }
}

# The default grants nothing of Bedrock and sets no transport: the worker keeps the
# direct API it had, and a rehearsal is not given a model it would call for its fixtures.
run "the_default_worker_has_no_bedrock_grant_and_no_transport_variable" {
  command = plan

  assert {
    condition = (
      !strcontains(aws_iam_role_policy.worker_task.policy, "bedrock:")
      && !contains(keys(output.worker_environment), "FSS_MODEL_TRANSPORT")
    )
    error_message = "worker_model_transport defaults to anthropic: no Bedrock statement, no FSS_MODEL_TRANSPORT."
  }
}
