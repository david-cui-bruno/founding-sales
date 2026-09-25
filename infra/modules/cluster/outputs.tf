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

output "api_task_role_arn" {
  description = "API task role ARN. The only principal permitted to append to the suppression journal."
  value       = aws_iam_role.api_task.arn
}

output "worker_task_role_arn" {
  description = "Worker task role ARN."
  value       = aws_iam_role.worker_task.arn
}

output "api_task_role_name" {
  description = "API task role name."
  value       = aws_iam_role.api_task.name
}

output "worker_task_role_name" {
  description = "Worker task role name."
  value       = aws_iam_role.worker_task.name
}

output "api_execution_role_arn" {
  description = "API execution role ARN."
  value       = aws_iam_role.api_execution.arn
}

output "worker_execution_role_arn" {
  description = "Worker execution role ARN."
  value       = aws_iam_role.worker_execution.arn
}

output "api_task_definition_arn" {
  description = "Current API task definition ARN."
  value       = aws_ecs_task_definition.api.arn
}

output "worker_task_definition_arn" {
  description = "Current worker task definition ARN."
  value       = aws_ecs_task_definition.worker.arn
}

output "migration_task_role_arn" {
  description = "Migration task role ARN. The identity `fss migrate` runs as."
  value       = aws_iam_role.migration_task.arn
}

output "migration_task_role_name" {
  description = "Migration task role name."
  value       = aws_iam_role.migration_task.name
}

output "migration_execution_role_arn" {
  description = "Migration execution role ARN. The only identity in this module that may resolve the migration database entry."
  value       = aws_iam_role.migration_execution.arn
}

output "migration_task_definition_arn" {
  description = "Task definition `fss migrate` and `fss admin database-users ensure` run under. Launched as a one-off task; it has no service."
  value       = aws_ecs_task_definition.migration.arn
}

output "migration_task_definition_family" {
  description = "Family name of the migration task definition, which is what a run-task argument names."
  value       = aws_ecs_task_definition.migration.family
}

output "operations_task_definition_arn" {
  description = "Task definition `fss verify` and `fss drill` run under, as the worker task role."
  value       = aws_ecs_task_definition.operations.arn
}

output "operations_task_definition_family" {
  description = "Family name of the operations task definition."
  value       = aws_ecs_task_definition.operations.family
}

output "drill_task_definition_family" {
  description = "Family name of the drill task definition."
  value       = aws_ecs_task_definition.drill.family
}

output "one_off_task_families" {
  description = <<-EOT
    The three one-off task definition families, which are names rather than
    ARNs and are therefore known at plan time. The roots assert them: an ARN
    is unknown until an apply, and a test that could only run against a real
    account is a test nobody runs.
  EOT
  value = [
    aws_ecs_task_definition.migration.family,
    aws_ecs_task_definition.operations.family,
    aws_ecs_task_definition.drill.family,
  ]
}

output "drill_task_definition_arn" {
  description = "Task definition `fss drill` runs under. Its own identity: the journal and the migration credential, which neither of the other two may hold together."
  value       = aws_ecs_task_definition.drill.arn
}

output "drill_task_role_name" {
  description = "Drill task role name."
  value       = aws_iam_role.drill_task.name
}

output "deployment_plan" {
  description = <<-EOT
    What `infra/scripts/release-deploy.sh` needs to know, read back from the
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
      declared_desired_count = var.worker_desired_count
      planned_desired_count  = aws_ecs_service.worker.desired_count
    }
    migration_task_definition  = aws_ecs_task_definition.migration.arn
    operations_task_definition = aws_ecs_task_definition.operations.arn
    drill_task_definition      = aws_ecs_task_definition.drill.arn
  }
}

output "api_environment" {
  description = "Non-secret API environment, for offline assertions. Never contains a credential."
  value       = local.api_environment
}

output "worker_environment" {
  description = "Non-secret environment of the worker service's task definition, for offline assertions. Never contains a credential. The one-off definitions carry the same minus FSS_EXPECTED_SYSTEM_GENERATION."
  value       = local.worker_service_environment
}

output "secret_environment_names" {
  description = "Environment variable names resolved from Secrets Manager at task start."
  value       = sort(keys(local.task_secrets))
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
