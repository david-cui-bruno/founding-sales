locals {
  # Only the two application services receive publisher authority. Migration and
  # operations retain their existing dedicated database/Gmail references.
  api_secret_names        = ["calcom", "device-credential-pepper", "google-gmail-oauth-client", "google-oidc-client", "session-signing-key", "social-publisher-session-key", "twilio-voice"]
  worker_secret_names     = ["sourcing-search", "zoom-meetings", "millionverifier-api-key", "calcom", "google-gmail-oauth-client", "llm-classifier-api-key", "social-publisher-session-key", "transcription", "twilio-voice"]
  operations_secret_names = ["google-gmail-oauth-client"]
  publisher_secret_names  = ["social-publisher-session-key"]
  secret_environment_names = {
    "llm-classifier-api-key"         = "FSS_LLM_CLASSIFIER_API_KEY"
    "millionverifier-api-key"        = "FSS_MILLIONVERIFIER_API_KEY"
    "sourcing-search"                = "FSS_TAVILY_API_KEY"
    # Reuse the accepted encryption key/container without rotating outstanding custody.
    "social-publisher-session-key"   = "FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY"
  }
  # Empty secret containers may exist before their values are installed. Inject
  # the encryption key only when the Buffer application configuration is ready.
  worker_injected_secret_names = [
    for name in local.worker_secret_names : name
    if(name != "millionverifier-api-key" || var.worker_reads_millionverifier_api_key)
    && (!contains(["llm-classifier-api-key", "sourcing-search"], name) || var.worker_reads_classifier_key)
    && (!contains(local.publisher_secret_names, name) || var.social_publisher_runtime_ready)
  ]
  runtime_database_secret = { DATABASE_SECRET_ARN = var.app_runtime_database_secret_arn }
  api_task_secrets = merge({
    for name, arn in var.secret_arns : lookup(local.secret_environment_names, name, name) => arn
    if contains(local.api_secret_names, name) && (!contains(local.publisher_secret_names, name) || var.social_publisher_runtime_ready)
  }, local.runtime_database_secret, local.browser_task_secrets)
  worker_task_secrets     = merge({ for name, arn in var.secret_arns : lookup(local.secret_environment_names, name, name) => arn if contains(local.worker_injected_secret_names, name) }, local.runtime_database_secret)
  operations_task_secrets = merge({ for name, arn in var.secret_arns : lookup(local.secret_environment_names, name, name) => arn if contains(local.operations_secret_names, name) }, local.runtime_database_secret)
  unassigned_secret_names = sort(setsubtract(keys(var.secret_arns), concat(local.api_secret_names, local.worker_secret_names, local.operations_secret_names)))
}
