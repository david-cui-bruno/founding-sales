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

output "api_environment" {
  description = "Non-secret API environment, for offline assertions. Never contains a credential."
  value       = local.api_environment
}

output "worker_environment" {
  description = "Non-secret worker environment, for offline assertions. Never contains a credential."
  value       = local.worker_environment
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
