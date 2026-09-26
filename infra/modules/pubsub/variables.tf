variable "gcp_project_id" {
  description = "Google Cloud project that owns the Gmail push topic. Production and rehearsal must never share one."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.gcp_project_id))
    error_message = "A Google Cloud project id is 6-30 lowercase letters, digits or hyphens starting with a letter."
  }
}

variable "name_prefix" {
  description = "Namespace applied to the topic and subscription names."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits or hyphens and start with a letter."
  }
}

variable "push_endpoint" {
  description = <<-EOT
    HTTPS URL of the API Gmail webhook. Pub/Sub delivers here with an OIDC token
    minted for exactly this URL as its audience; the webhook validates signature,
    issuer, this exact audience, the service-account email, email_verified,
    expiry and issued-at bounds before doing anything.
  EOT
  type        = string

  validation {
    condition     = startswith(var.push_endpoint, "https://")
    error_message = "The push endpoint must be HTTPS. A notification carries a mailbox address and must never travel in the clear."
  }
}
