# FSS greenfield runtime: one ECS cluster and two Fargate services.
#
# The API and the worker are separate services with separate task roles and
# separate execution roles, so the worker's Gmail and research reach is not the
# API's. Both may append to the suppression journal and neither may delete from
# it: 10.2 requires the journal write before acknowledgement, and the worker
# records prospect opt-outs during mail sync.
#
# Images are digests. A tag is refused by variable validation, because the
# release gate compares the digest that passed rehearsal with the digest that
# is deployed, and a mutable tag cannot carry that comparison.
#
# Both services run the deployment circuit breaker with rollback, so a task
# that cannot pass its health check returns the service to the last good
# definition rather than draining the healthy one.

locals {
  api_task_role_name            = "${var.name_prefix}-api-task"
  worker_task_role_name         = "${var.name_prefix}-worker-task"
  api_execution_role_name       = "${var.name_prefix}-api-exec"
  worker_execution_role_name    = "${var.name_prefix}-worker-exec"
  migration_task_role_name      = "${var.name_prefix}-migration-task"
  migration_execution_role_name = "${var.name_prefix}-migration-exec"
  drill_task_role_name          = "${var.name_prefix}-drill-task"
  drill_execution_role_name     = "${var.name_prefix}-drill-exec"

  # What the two services' execution roles may resolve: the application secrets
  # and the `app_runtime` database entry. Deliberately not the migration entry,
  # and deliberately not the RDS-managed master secret — the services connect as
  # `app_runtime`, and the only identities that may reach a credential able to
  # perform DDL are the migration execution role and the operator.
  runtime_secret_arns = distinct(concat(values(var.secret_arns), [var.app_runtime_database_secret_arn]))

  # What the migration execution role may resolve. The runtime entry is here
  # because `fss admin database-users ensure` is the thing that sets that
  # password; nothing else in this module gives the migration identity reach.
  migration_secret_arns = distinct([var.migration_database_secret_arn, var.app_runtime_database_secret_arn])

  # The drill's execution role: the application secrets, the runtime entry and the
  # migration entry, because Appendix E step 7 reapplies migrations forward inside
  # the same process that replayed the journal.
  drill_secret_arns = distinct(concat(local.runtime_secret_arns, [var.migration_database_secret_arn]))

  # The tool, as the container's entry point. `aws ecs run-task --overrides` can
  # replace a container's `command` and cannot replace its `entryPoint`, and the
  # worker image's entry point is the worker. So the one-off task definitions
  # below declare the tool as their entry point and take the subcommand as the
  # command; a definition that expected otherwise would start a worker every
  # time an operator asked it for a migration.
  fss_entry_point = ["node", "apps/worker/src/tools/fss.ts"]

  # Bootstrap: see the variable. Both services are created at zero on the first
  # apply of a fresh environment and scaled by the shared deploy script once the
  # migration task and `fss verify` have succeeded.
  api_desired_count    = var.bootstrap ? 0 : var.api_desired_count
  worker_desired_count = var.bootstrap ? 0 : var.worker_desired_count

  common_environment = merge(var.environment, {
    FSS_NAME_PREFIX      = var.name_prefix
    FSS_METRIC_NAMESPACE = var.metric_namespace
    AWS_REGION           = var.aws_region
  })

  # Appendix E step 1, on the two services only (lane g56). Absent rather than
  # empty when unpinned: both bootstraps read an absent variable as "the check is
  # not made" and refuse an empty one. The one-off definitions below are built from
  # `worker_environment`, not from `worker_service_environment`, so a pin never
  # reaches them; the commands that need a generation take it as a flag.
  generation_environment = var.expected_system_generation == null ? {} : {
    FSS_EXPECTED_SYSTEM_GENERATION = tostring(var.expected_system_generation)
  }

  api_environment = merge(local.common_environment, var.api_environment, {
    FSS_ROLE        = "api"
    FSS_SCHEMA_MIN  = tostring(var.api_schema_range.min)
    FSS_SCHEMA_MAX  = tostring(var.api_schema_range.max)
    PORT            = tostring(var.container_port)
    FSS_HTTP_PORT   = tostring(var.container_port)
    FSS_JOURNAL_ARN = var.journal_bucket_arn
  }, local.generation_environment)

  worker_environment = merge(local.common_environment, var.worker_environment, {
    FSS_ROLE       = "worker"
    FSS_SCHEMA_MIN = tostring(var.worker_schema_range.min)
    FSS_SCHEMA_MAX = tostring(var.worker_schema_range.max)
  })

  # What the worker *service* runs with: the one-off environment plus the pin.
  worker_service_environment = merge(local.worker_environment, local.generation_environment)

  task_secrets = merge(var.secret_arns, { DATABASE_SECRET_ARN = var.app_runtime_database_secret_arn })

  # The migration task's two references, with the names the tool reads
  # (`apps/worker/src/tools/fss/config.ts`, `TOOL_ENVIRONMENT_VARIABLES`, and
  # `databaseUsers.ts`, `RUNTIME_SECRET_VARIABLE`).
  #
  # `MIGRATION_DATABASE_SECRET` is the credential `fss migrate` connects with, and
  # the tool never falls back to `DATABASE_SECRET_ARN` for it: this task definition
  # deliberately does not carry the runtime connection at all, so a migration
  # applied with the application's credential is not a mistake that can be made
  # here. `FSS_RUNTIME_DATABASE_SECRET_ARN` is the *value* of the runtime entry,
  # which `fss admin database-users ensure` reads the login user's name and
  # password out of. Both arrive through the ECS `secrets` block, so neither is
  # ever an argument, an environment literal or a line in a log.
  migration_task_secrets = {
    MIGRATION_DATABASE_SECRET       = var.migration_database_secret_arn
    FSS_RUNTIME_DATABASE_SECRET_ARN = var.app_runtime_database_secret_arn
  }

  # `fss verify` runs as the *runtime* identity, with the runtime connection and
  # nothing else. A verify that passed as the migration user would prove nothing
  # about the credential the services are about to use.
  operations_environment = local.worker_environment

  # `fss drill` needs both: steps 2 to 6, 8 and 9 are the application's work and
  # step 7 reapplies migrations forward, which is DDL. So it is its own task
  # definition under its own identity rather than either of the other two — the
  # migration role must stay unable to reach the journal, and the worker service's
  # role must stay unable to reach a DDL credential (David's condition 1).
  drill_task_secrets = merge(local.task_secrets, {
    MIGRATION_DATABASE_SECRET = var.migration_database_secret_arn
  })

  # `recorded`, in the task definition, not as an override.
  #
  # The drill runs `mailbox reconcile-sent`, `mailbox recover` and `watch-renew`,
  # every one of which reaches Gmail when dependencies are `live`. A rehearsal that
  # reached a real mailbox would send real mail, and a mode chosen by the caller is
  # a mode a caller can forget. So the definition fixes it and the tool refuses to
  # drill in any other mode.
  drill_environment = merge(local.worker_environment, { FSS_DEPENDENCIES = "recorded" })

  migration_environment = merge(local.common_environment, {
    # The tool deliberately does not read FSS_SCHEMA_MIN/MAX: `fss migrate` is
    # the command that makes the declared range true, so requiring the range to
    # agree first would be a tool that cannot be used for the one thing it is
    # for. What it does carry is the range it is migrating *towards*, as a
    # public identifier, so an operator reading the task's log knows which
    # release this migration belongs to.
    FSS_TARGET_SCHEMA_MIN     = tostring(var.worker_schema_range.min)
    FSS_TARGET_SCHEMA_MAX     = tostring(var.worker_schema_range.max)
    FSS_MIGRATION_TASK        = "${var.name_prefix}-migration"
    FSS_RUNTIME_DATABASE_ROLE = "app_runtime"
  })

  journal_object_arn = "${var.journal_bucket_arn}/*"

  ecs_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-cluster" })
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# ---------------------------------------------------------------------------
# Execution roles. These pull the image and resolve secret references at task
# start. They are not the roles the application code runs as.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api_execution" {
  name               = local.api_execution_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.api_execution_role_name })
}

resource "aws_iam_role" "worker_execution" {
  name               = local.worker_execution_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.worker_execution_role_name })
}

resource "aws_iam_role_policy_attachment" "api_execution_managed" {
  role       = aws_iam_role.api_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy_attachment" "worker_execution_managed" {
  role       = aws_iam_role.worker_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "api_execution_secrets" {
  name = "secret-references"
  role = aws_iam_role.api_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlyTheNamedSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.runtime_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.secrets_kms_key_arn]
      },
    ]
  })
}

resource "aws_iam_role_policy" "worker_execution_secrets" {
  name = "secret-references"
  role = aws_iam_role.worker_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlyTheNamedSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.runtime_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.secrets_kms_key_arn]
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# The migration identity (G12h).
#
# David's condition of 21 September: a distinct migration task role and task
# definition, and the runtime task role with no path to DDL credentials. Two
# roles, because the split between "resolves the credential at task start" and
# "is what the code runs as" is the same split the services keep, and because
# the credential is the thing being fenced off.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "migration_execution" {
  name               = local.migration_execution_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.migration_execution_role_name })
}

resource "aws_iam_role_policy_attachment" "migration_execution_managed" {
  role       = aws_iam_role.migration_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "migration_execution_secrets" {
  name = "secret-references"
  role = aws_iam_role.migration_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Two entries and no others. Not the Gmail client, not the session key,
        # not the classifier key: a migration needs a database and nothing else,
        # and an identity that could resolve the mail credential is an identity
        # a future mistake could send mail with.
        Sid      = "ReadOnlyTheTwoDatabaseEntries"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.migration_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.secrets_kms_key_arn]
      },
    ]
  })
}

resource "aws_iam_role" "migration_task" {
  name               = local.migration_task_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.migration_task_role_name })
}

resource "aws_iam_role_policy" "migration_task" {
  name = "migration-runtime"
  role = aws_iam_role.migration_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The whole of it. No S3, no journal key, no envelope key: `fss migrate`
        # and `fss admin database-users ensure` talk to PostgreSQL, and the only
        # thing they do outside it is say how long they took.
        Sid      = "PublishOperationalMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "cloudwatch:namespace" = var.metric_namespace }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# The drill identity (G12h).
#
# `fss drill` is Appendix E steps 1 to 9 in one process, and it needs two things
# neither of the other two identities may have together: the suppression journal
# (step 2 replays it) and the migration credential (step 7 reapplies migrations
# forward). Giving them to the migration role would make the DDL identity able to
# read the journal; giving them to the worker service's role would give the
# runtime a path to DDL, which is the thing David's first condition removes.
#
# So it is a third identity, used by nothing but the drill, which exists in a
# rehearsal and is never launched in production.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "drill_execution" {
  name               = local.drill_execution_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.drill_execution_role_name })
}

resource "aws_iam_role_policy_attachment" "drill_execution_managed" {
  role       = aws_iam_role.drill_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "drill_execution_secrets" {
  name = "secret-references"
  role = aws_iam_role.drill_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOnlyTheNamedSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = local.drill_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.secrets_kms_key_arn]
      },
    ]
  })
}

resource "aws_iam_role" "drill_task" {
  name               = local.drill_task_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.drill_task_role_name })
}

resource "aws_iam_role_policy" "drill_task" {
  name = "drill-runtime"
  role = aws_iam_role.drill_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Read, and only read. Appendix E step 2 replays what the journal already
        # holds into the restored database; a drill that could write the journal
        # could manufacture the evidence it is checked against.
        Sid      = "ReplayTheJournalAfterRestore"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
        Resource = [var.journal_bucket_arn, local.journal_object_arn]
      },
      {
        Sid      = "DecryptJournalObjects"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.journal_kms_key_arn]
      },
      {
        # No envelope key: the drill runs with FSS_DEPENDENCIES=recorded, fixed in
        # the task definition, so the mail commands reach the recorded adapters and
        # there is no real refresh token to unwrap. A key granted to an identity
        # that has nothing to use it on is a grant nobody can justify later.
        Sid      = "PublishOperationalMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "cloudwatch:namespace" = var.metric_namespace }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Task roles. These are the application identities.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "api_task" {
  name               = local.api_task_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.api_task_role_name })
}

resource "aws_iam_role" "worker_task" {
  name               = local.worker_task_role_name
  assume_role_policy = local.ecs_assume_role_policy
  tags               = merge(var.tags, { Name = local.worker_task_role_name })
}

resource "aws_iam_role_policy" "api_task" {
  name = "api-runtime"
  role = aws_iam_role.api_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AppendSuppressionEvents"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = [local.journal_object_arn]
      },
      {
        Sid      = "ReadTheJournalForReconciliation"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
        Resource = [var.journal_bucket_arn, local.journal_object_arn]
      },
      {
        Sid      = "UseTheJournalKey"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.journal_kms_key_arn]
      },
      {
        Sid      = "UnwrapMailboxRefreshTokens"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.envelope_kms_key_arn]
      },
      {
        Sid      = "PublishOperationalMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "cloudwatch:namespace" = var.metric_namespace }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "worker_task" {
  name = "worker-runtime"
  role = aws_iam_role.worker_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # 10.2: the worker's mail pipeline records prospect opt-outs during sync
        # and must journal them *before* acknowledging. No delete, in any form:
        # the bucket policy denies deletion to every principal and this policy
        # never asks for it, so the journal stays append-only from both sides.
        Sid      = "AppendSuppressionEvents"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = [local.journal_object_arn]
      },
      {
        Sid      = "ReplayTheJournalAfterRestore"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
        Resource = [var.journal_bucket_arn, local.journal_object_arn]
      },
      {
        # Encrypt and GenerateDataKey are what a put into an SSE-KMS bucket
        # needs; Decrypt is what Appendix E step 2's replay needs. The bucket's
        # own default retention locks each object, so no writer ever sets one
        # and s3:PutObjectRetention is denied to everybody, including these two.
        Sid      = "UseTheJournalKey"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.journal_kms_key_arn]
      },
      {
        Sid      = "UnwrapMailboxRefreshTokens"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = [var.envelope_kms_key_arn]
      },
      {
        Sid      = "PublishOperationalMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = ["*"]
        Condition = {
          StringEquals = { "cloudwatch:namespace" = var.metric_namespace }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Task definitions and services.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.api_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image
      essential = true

      portMappings = [{
        containerPort = var.container_port
        protocol      = "tcp"
      }]

      environment = [for name in sort(keys(local.api_environment)) : {
        name  = name
        value = local.api_environment[name]
      }]

      secrets = [for name in sort(keys(local.task_secrets)) : {
        name      = name
        valueFrom = local.task_secrets[name]
      }]

      healthCheck = {
        command     = var.api_health_check_command
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.api_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api"
        }
      }

      stopTimeout = 30
    },
  ])

  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = var.worker_image
      essential = true

      environment = [for name in sort(keys(local.worker_service_environment)) : {
        name  = name
        value = local.worker_service_environment[name]
      }]

      secrets = [for name in sort(keys(local.task_secrets)) : {
        name      = name
        valueFrom = local.task_secrets[name]
      }]

      healthCheck = {
        command     = var.worker_health_check_command
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.worker_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }

      # A worker that is stopping must be allowed to finish the claim it holds
      # and release its lease cleanly rather than being killed mid-transaction.
      stopTimeout = 120
    },
  ])

  tags = merge(var.tags, { Name = "${var.name_prefix}-worker" })
}

# ---------------------------------------------------------------------------
# The two one-off task definitions. Neither has a service; both are launched by
# `infra/scripts/release-deploy.sh` through `infra/scripts/rehearsal-run-task.sh`,
# which reads the exit code and the log stream.
#
# They carry the worker image at the release digest because the database is
# private and the worker image is the only thing already inside the VPC that can
# reach it — and because running the migration from the same artifact that is
# about to run against the schema is the whole argument for doing it this way.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "migration" {
  family                   = "${var.name_prefix}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migration_cpu)
  memory                   = tostring(var.migration_memory)
  execution_role_arn       = aws_iam_role.migration_execution.arn
  task_role_arn            = aws_iam_role.migration_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name       = "migration"
      image      = var.worker_image
      essential  = true
      entryPoint = local.fss_entry_point
      command    = ["migrate"]

      environment = [for name in sort(keys(local.migration_environment)) : {
        name  = name
        value = local.migration_environment[name]
      }]

      secrets = [for name in sort(keys(local.migration_task_secrets)) : {
        name      = name
        valueFrom = local.migration_task_secrets[name]
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.worker_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migration"
        }
      }

      # A migration under an advisory lock must be allowed to finish or to roll
      # back cleanly rather than be killed with the lock held.
      stopTimeout = 120
    },
  ])

  tags = merge(var.tags, { Name = "${var.name_prefix}-migration" })
}

resource "aws_ecs_task_definition" "operations" {
  family                   = "${var.name_prefix}-operations"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migration_cpu)
  memory                   = tostring(var.migration_memory)
  execution_role_arn       = aws_iam_role.worker_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name       = "operations"
      image      = var.worker_image
      essential  = true
      entryPoint = local.fss_entry_point
      # `verify` reads the schema, reports the configured parts, and performs one
      # write and read inside a transaction it rolls back. It is the safest thing
      # in the tool, which is why it is the default a dropped override falls back
      # to rather than something that changes state.
      command = ["verify"]

      environment = [for name in sort(keys(local.operations_environment)) : {
        name  = name
        value = local.operations_environment[name]
      }]

      secrets = [for name in sort(keys(local.task_secrets)) : {
        name      = name
        valueFrom = local.task_secrets[name]
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.worker_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "operations"
        }
      }

      stopTimeout = 120
    },
  ])

  tags = merge(var.tags, { Name = "${var.name_prefix}-operations" })
}

resource "aws_ecs_task_definition" "drill" {
  family                   = "${var.name_prefix}-drill"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.migration_cpu)
  memory                   = tostring(var.migration_memory)
  execution_role_arn       = aws_iam_role.drill_execution.arn
  task_role_arn            = aws_iam_role.drill_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name       = "drill"
      image      = var.worker_image
      essential  = true
      entryPoint = local.fss_entry_point
      command    = ["drill", "--reports", "/tmp/fss-drill"]

      environment = [for name in sort(keys(local.drill_environment)) : {
        name  = name
        value = local.drill_environment[name]
      }]

      secrets = [for name in sort(keys(local.drill_task_secrets)) : {
        name      = name
        valueFrom = local.drill_task_secrets[name]
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.worker_log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "drill"
        }
      }

      # Appendix E steps 1 to 9 in one process against a restored instance. The
      # journal replay is the long one and it must not be killed part-way.
      stopTimeout = 120
    },
  ])

  tags = merge(var.tags, { Name = "${var.name_prefix}-drill" })
}

resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = local.api_desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  enable_ecs_managed_tags = true
  enable_execute_command  = var.enable_execute_command

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.api_security_group_ids
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.container_port
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-api" })
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name_prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = local.worker_desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  enable_ecs_managed_tags = true
  enable_execute_command  = var.enable_execute_command

  # Replace rather than overlap. Overlapping workers are safe (the scheduler
  # pass takes a transaction advisory lock and every handler is protected by
  # business uniqueness or the outbound fence), but a clean replacement keeps
  # the dispatch fence story simple during a deployment.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.worker_security_group_ids
    assign_public_ip = true
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-worker" })
}
