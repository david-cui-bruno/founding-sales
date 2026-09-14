# Compatibility entry point. Worker resources have a single implementation shared
# with ../worker-terraform. Do not enable both roots for the same worker.
module "delegated_worker" {
  source = "./modules/delegated-worker"

  providers = {
    aws     = aws
    archive = archive
  }

  aws_region                             = var.aws_region
  aws_account_id                         = var.aws_account_id
  name_prefix                            = var.name_prefix
  iam_path                               = var.iam_path
  delegated_worker_enabled               = var.delegated_worker_enabled
  delegated_worker_activation_reviewed   = var.delegated_worker_activation_reviewed
  delegated_workspace_id                 = var.delegated_workspace_id
  delegated_google_client_id             = var.delegated_google_client_id
  delegated_research_enabled             = var.delegated_research_enabled
  delegated_research_reviewed_capability = var.delegated_research_reviewed_capability
  delegated_worker_research_once_enabled = var.delegated_worker_research_once_enabled
  delegated_worker_schedule_enabled      = var.delegated_worker_schedule_enabled
  worker_source_dir                      = "${path.module}/../lambdas/delegated-worker/dist"
  worker_output_path                     = "${path.module}/.build/delegated-worker.zip"
}

output "delegated_worker_endpoint" {
  description = "HTTPS base only, never a bearer or unauthenticated stop URL."
  value       = module.delegated_worker.delegated_worker_endpoint
}

# Same-state address migration only. Whole-resource moves retain every count
# index and route for_each key, including the optional schedule. These do NOT
# transfer ownership to the separate worker root/state. Keep these indefinitely.
moved {
  from = aws_kms_key.delegated_worker
  to   = module.delegated_worker.aws_kms_key.delegated_worker
}
moved {
  from = aws_dynamodb_table.delegated_worker
  to   = module.delegated_worker.aws_dynamodb_table.delegated_worker
}
moved {
  from = aws_cloudwatch_log_group.delegated_worker
  to   = module.delegated_worker.aws_cloudwatch_log_group.delegated_worker
}
moved {
  from = aws_cloudwatch_log_group.delegated_worker_api
  to   = module.delegated_worker.aws_cloudwatch_log_group.delegated_worker_api
}
moved {
  from = aws_iam_role.delegated_worker
  to   = module.delegated_worker.aws_iam_role.delegated_worker
}
moved {
  from = aws_iam_role_policy.delegated_worker
  to   = module.delegated_worker.aws_iam_role_policy.delegated_worker
}
moved {
  from = data.archive_file.delegated_worker
  to   = module.delegated_worker.data.archive_file.delegated_worker
}
moved {
  from = aws_lambda_function.delegated_worker
  to   = module.delegated_worker.aws_lambda_function.delegated_worker
}
moved {
  from = aws_apigatewayv2_api.delegated_worker
  to   = module.delegated_worker.aws_apigatewayv2_api.delegated_worker
}
moved {
  from = aws_apigatewayv2_integration.delegated_worker
  to   = module.delegated_worker.aws_apigatewayv2_integration.delegated_worker
}
moved {
  from = aws_apigatewayv2_route.delegated_worker
  to   = module.delegated_worker.aws_apigatewayv2_route.delegated_worker
}
moved {
  from = aws_apigatewayv2_stage.delegated_worker
  to   = module.delegated_worker.aws_apigatewayv2_stage.delegated_worker
}
moved {
  from = aws_lambda_permission.delegated_worker_api
  to   = module.delegated_worker.aws_lambda_permission.delegated_worker_api
}
moved {
  from = aws_cloudwatch_event_rule.delegated_worker
  to   = module.delegated_worker.aws_cloudwatch_event_rule.delegated_worker
}
moved {
  from = aws_cloudwatch_event_target.delegated_worker
  to   = module.delegated_worker.aws_cloudwatch_event_target.delegated_worker
}
moved {
  from = aws_lambda_permission.delegated_worker_schedule
  to   = module.delegated_worker.aws_lambda_permission.delegated_worker_schedule
}
