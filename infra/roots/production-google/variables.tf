variable "name_prefix" {
  description = <<-EOT
    The production namespace, and the stem of every Google object name here:
    `fss-prod-gmail-push` is the topic, the subscription and the service
    account id. It is fixed for the same reason it is fixed in
    `infra/roots/production`: there is one production, and there is no
    rehearsal Google Cloud project to name (`docs/archive/decisions/g12j-the-rehearsal-has-no-google-provider.md`).
  EOT
  type        = string
  default     = "fss-prod"

  validation {
    condition     = var.name_prefix == "fss-prod"
    error_message = "The production Google root owns exactly the fss-prod namespace. A rehearsal has no Google Cloud project and no Google root."
  }
}

variable "gcp_project_id" {
  description = <<-EOT
    The production Google Cloud project that owns the Gmail push topic. A public
    identifier, and the default is the project the four objects were created in
    on 23 September 2026 (`docs/greenfield/release.md` 4 and 8.0n), so that a
    plan here names the objects that exist without anybody typing it.
  EOT
  type        = string
  default     = "callie-fss"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.gcp_project_id))
    error_message = "A Google Cloud project id is 6-30 lowercase letters, digits or hyphens starting with a letter."
  }
}

variable "gcp_region" {
  description = "Google Cloud region for the provider. Pub/Sub topics are global; this only sets the provider's default."
  type        = string
  default     = "us-east1"
}

variable "api_hostname" {
  description = <<-EOT
    The production API hostname, the same value `infra/roots/production` is
    planned with (`api.usecallie.com`). The subscription pushes to
    `https://<api_hostname><gmail_push_path>` and mints its token for exactly
    that audience; the production root derives `FSS_GMAIL_PUSH_AUDIENCE` from
    its own `api_hostname` with the same expression, so the two roots agree as
    long as both are given the same hostname. Required, as it is there.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.api_hostname))
    error_message = "api_hostname is a bare hostname: no scheme, no port and no path. The push endpoint is built as https://<api_hostname><gmail_push_path>."
  }
}

variable "gmail_push_path" {
  description = <<-EOT
    Path on the API that Pub/Sub pushes to. It is the same route in every
    environment and the same default as `infra/roots/production`, which builds
    the audience the webhook requires from it; the release suite compares the
    two defaults.
  EOT
  type        = string
  default     = "/integrations/gmail/push"

  validation {
    condition     = startswith(var.gmail_push_path, "/")
    error_message = "The push path is a path on the API, beginning with a slash."
  }
}
