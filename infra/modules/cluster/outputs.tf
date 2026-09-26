output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.main.arn
}

output "api_service_name" {
  description = "API service name."
  value       = aws_ecs_service.api.name
}

output "worker_service_name" {
  description = "Worker service name."
  value       = aws_ecs_service.worker.name
}

output "api_task_role_name" {
  description = "API task role name."
  value       = aws_iam_role.api_task.name
}

output "worker_task_role_name" {
  description = "Worker task role name."
  value       = aws_iam_role.worker_task.name
}

output "migration_task_role_name" {
  description = "Migration task role name."
  value       = aws_iam_role.migration_task.name
}

output "migration_task_definition_arn" {
  description = "Task definition `fss migrate` and `fss admin database-users ensure` run under. Launched as a one-off task; it has no service."
  value       = aws_ecs_task_definition.migration.arn
}

output "operations_task_definition_arn" {
  description = "Task definition `fss verify` runs under, as the worker task role."
  value       = aws_ecs_task_definition.operations.arn
}

output "operations_task_definition_family" {
  description = "Family name of the operations task definition."
  value       = aws_ecs_task_definition.operations.family
}

output "one_off_task_families" {
  description = <<-EOT
    The two one-off task definition families, which are names rather than
    ARNs and are therefore known at plan time. The roots assert them: an ARN
    is unknown until an apply, and a test that could only run against a real
    account is a test nobody runs.
  EOT
  value = [
    aws_ecs_task_definition.migration.family,
    aws_ecs_task_definition.operations.family,
  ]
}

output "deployment_plan" {
  description = <<-EOT
    What `infra/scripts/deploy.sh release` needs to know, read back from the
    resources rather than echoed from the variables.

    `declared_desired_count` is what the service is *for*; `planned_desired_count`
    is what this apply creates it at, which is zero on a bootstrap. The script's
    scale-up target is the declared number, so the count in the cloud and the
    count in the root cannot drift apart through a literal in a shell file.

    After the first apply `planned_desired_count` is the count Terraform last
    read from ECS rather than one it sets: both services ignore changes to
    `desired_count` (lane g70), and the release scripts own it from there.
  EOT
  value = {
    bootstrap = var.bootstrap
    api = {
      service_name           = aws_ecs_service.api.name
      declared_desired_count = var.api_desired_count
      planned_desired_count  = aws_ecs_service.api.desired_count
    }
    worker = {
      service_name           = aws_ecs_service.worker.name
      declared_desired_count = local.worker_declared_desired_count
      planned_desired_count  = aws_ecs_service.worker.desired_count
    }
    migration_task_definition  = aws_ecs_task_definition.migration.arn
    operations_task_definition = aws_ecs_task_definition.operations.arn
  }
}

output "api_environment" {
  description = "Non-secret API environment, for offline assertions. Never contains a credential."
  value       = local.api_environment
}

output "worker_environment" {
  description = "Non-secret environment of the worker service's task definition, for offline assertions. Never contains a credential."
  value       = local.worker_environment
}

output "task_secret_names" {
  description = "Per task definition, the environment variable names resolved from Secrets Manager at task start (lane g81): each process gets the secrets it reads and no others. Names only, never an ARN or a value."
  value = {
    api        = sort(keys(local.api_task_secrets))
    worker     = sort(keys(local.worker_task_secrets))
    operations = sort(keys(local.operations_task_secrets))
    migration  = sort(keys(local.migration_task_secrets))
  }
}

output "service_shape" {
  description = <<-EOT
    The size and count each service actually plans, read back from the
    resources. The root tests assert David's topology answers against this
    rather than against the variables they were passed, because a default that
    never reaches a task definition is the failure mode this output exists for.
  EOT
  value = {
    api = {
      cpu           = aws_ecs_task_definition.api.cpu
      memory        = aws_ecs_task_definition.api.memory
      desired_count = aws_ecs_service.api.desired_count
    }
    worker = {
      cpu           = aws_ecs_task_definition.worker.cpu
      memory        = aws_ecs_task_definition.worker.memory
      desired_count = aws_ecs_service.worker.desired_count
    }
  }
}

output "task_runtime_platform" {
  description = <<-EOT
    The runtime platform each task definition actually declares, read back from
    the resources rather than echoed from the variable. The images are built
    `linux/arm64`; a task definition that asks Fargate for X86_64 pulls a
    manifest that does not exist and the service never stabilises, so the root
    tests assert this rather than assert the value they passed.
  EOT
  value = {
    api = {
      operating_system_family = aws_ecs_task_definition.api.runtime_platform[0].operating_system_family
      cpu_architecture        = aws_ecs_task_definition.api.runtime_platform[0].cpu_architecture
    }
    worker = {
      operating_system_family = aws_ecs_task_definition.worker.runtime_platform[0].operating_system_family
      cpu_architecture        = aws_ecs_task_definition.worker.runtime_platform[0].cpu_architecture
    }
  }
}
