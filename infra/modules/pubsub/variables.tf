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

variable "push_service_account_id" {
  description = "Service account id for the push identity. Google allows 6-30 characters."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{5,29}$", var.push_service_account_id))
    error_message = "A service account id is 6-30 lowercase letters, digits or hyphens starting with a letter."
  }
}

variable "push_endpoint" {
  description = "HTTPS URL of the API Gmail webhook. Pub/Sub delivers here with an OIDC token."
  type        = string

  validation {
    condition     = startswith(var.push_endpoint, "https://")
    error_message = "The push endpoint must be HTTPS. A notification carries a mailbox address and must never travel in the clear."
  }
}

variable "push_audience" {
  description = <<-EOT
    Exact audience the API requires in the OIDC token. The webhook validates
    signature, issuer, this exact audience, the service-account email,
    email_verified, expiry and issued-at bounds before doing anything.
  EOT
  type        = string

  validation {
    condition     = length(var.push_audience) > 0
    error_message = "The audience must be set. An empty audience cannot be validated."
  }
}

variable "gmail_publisher_service_account" {
  description = "The Google-owned identity that publishes Gmail notifications. This is a fixed public Google identifier."
  type        = string
  default     = "gmail-api-push@system.gserviceaccount.com"
}

variable "ack_deadline_seconds" {
  description = "Seconds Pub/Sub waits for the webhook to acknowledge. The webhook acknowledges only after durable recording or enqueueing."
  type        = number
  default     = 30
}

variable "message_retention_duration" {
  description = "How long Pub/Sub keeps an unacknowledged notification. One-minute reconciliation is the real safety net."
  type        = string
  default     = "3600s"
}

variable "minimum_backoff" {
  description = "Minimum retry backoff."
  type        = string
  default     = "10s"
}

variable "maximum_backoff" {
  description = "Maximum retry backoff."
  type        = string
  default     = "600s"
}

variable "labels" {
  description = "Labels applied to the topic and subscription."
  type        = map(string)
  default     = {}
}
