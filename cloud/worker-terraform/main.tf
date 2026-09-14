# This root loads only the worker module, never the legacy sourcing root.
# State ownership and backend review are mandatory before initialization/use.
module "delegated_worker" {
  source = "../terraform/modules/delegated-worker"

  providers = {
    aws     = aws
    archive = archive
  }

  aws_region                           = var.aws_region
  aws_account_id                       = var.aws_account_id
  name_prefix                          = var.name_prefix
  iam_path                             = var.iam_path
  delegated_worker_enabled             = var.delegated_worker_enabled
  delegated_worker_activation_reviewed = var.delegated_worker_activation_reviewed
  delegated_workspace_id               = var.delegated_workspace_id
  delegated_google_client_id           = var.delegated_google_client_id
  delegated_research_enabled           = var.delegated_research_enabled
  delegated_worker_schedule_enabled    = var.delegated_worker_schedule_enabled
  worker_source_dir                    = "${path.module}/../lambdas/delegated-worker/dist"
  worker_output_path                   = "${path.module}/.build/delegated-worker.zip"
}

output "delegated_worker_endpoint" {
  description = "HTTPS base only, never a bearer or unauthenticated stop URL."
  value       = module.delegated_worker.delegated_worker_endpoint
}
