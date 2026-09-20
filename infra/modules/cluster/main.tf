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
  api_task_role_name         = "${var.name_prefix}-api-task"
  worker_task_role_name      = "${var.name_prefix}-worker-task"
  api_execution_role_name    = "${var.name_prefix}-api-exec"
  worker_execution_role_name = "${var.name_prefix}-worker-exec"

  all_secret_arns = distinct(concat(values(var.secret_arns), [var.database_master_secret_arn]))

  common_environment = merge(var.environment, {
    FSS_NAME_PREFIX      = var.name_prefix
    FSS_METRIC_NAMESPACE = var.metric_namespace
    AWS_REGION           = var.aws_region
  })

  api_environment = merge(local.common_environment, var.api_environment, {
    FSS_ROLE        = "api"
    FSS_SCHEMA_MIN  = tostring(var.api_schema_range.min)
    FSS_SCHEMA_MAX  = tostring(var.api_schema_range.max)
    PORT            = tostring(var.container_port)
    FSS_HTTP_PORT   = tostring(var.container_port)
    FSS_JOURNAL_ARN = var.journal_bucket_arn
  })

  worker_environment = merge(local.common_environment, var.worker_environment, {
    FSS_ROLE       = "worker"
    FSS_SCHEMA_MIN = tostring(var.worker_schema_range.min)
    FSS_SCHEMA_MAX = tostring(var.worker_schema_range.max)
  })

  task_secrets = merge(var.secret_arns, { DATABASE_SECRET_ARN = var.database_master_secret_arn })

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
        Resource = local.all_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = distinct([var.secrets_kms_key_arn, var.database_kms_key_arn])
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
        Resource = local.all_secret_arns
      },
      {
        Sid      = "DecryptTheSecretKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = distinct([var.secrets_kms_key_arn, var.database_kms_key_arn])
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

      environment = [for name in sort(keys(local.worker_environment)) : {
        name  = name
        value = local.worker_environment[name]
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

resource "aws_ecs_service" "api" {
  name            = "${var.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
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
  desired_count   = var.worker_desired_count
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
