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
