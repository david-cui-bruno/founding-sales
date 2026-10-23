# Optional founder host shares the existing API container and execution role.
# The existing secret must contain the raw hex key, not a JSON envelope. Use the
# stack's existing Secrets Manager KMS key (or the AWS-managed default key).
# No task role, worker, operations or migration identity receives this reference.
variable "founder_browser" {
  description = "Null disables browser hosting. References only, never cookie key material."
  type = object({
    origin             = optional(string, "https://sales.usecallie.com")
    clientVersion      = string
    founderWorkspaceId = string
    founderUserId      = string
    cookieKeySecretArn = string
    certificateArn     = optional(string)
  })
  default = null
}

locals {
  browser_environment = var.founder_browser == null ? {} : {
    FSS_BROWSER_ORIGIN               = var.founder_browser.origin
    FSS_BROWSER_CLIENT_VERSION       = var.founder_browser.clientVersion
    FSS_BROWSER_FOUNDER_WORKSPACE_ID = var.founder_browser.founderWorkspaceId
    FSS_BROWSER_FOUNDER_USER_ID      = var.founder_browser.founderUserId
  }
  browser_task_secrets = var.founder_browser == null ? {} : {
    FSS_BROWSER_COOKIE_KEY_HEX = var.founder_browser.cookieKeySecretArn
  }
  api_environment = merge(local.common_environment, var.api_environment, local.browser_environment, {
    # Preview prices the worker's transport without granting the API model IAM.
    FSS_MODEL_TRANSPORT = var.worker_model_transport
    FSS_ROLE            = "api"
    FSS_SCHEMA_MIN      = tostring(var.api_schema_range.min)
    FSS_SCHEMA_MAX      = tostring(var.api_schema_range.max)
    PORT                = tostring(var.container_port)
    FSS_HTTP_PORT       = tostring(var.container_port)
    FSS_JOURNAL_ARN     = var.journal_bucket_arn
    # Existing deletion workflow's best-effort call-object deletion.
    FSS_CALL_AUDIO_BUCKET = local.call_audio_bucket_name
  })
}
